"""Core skill post-processing — lexicon classification of LLM-extracted skills.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from app.services.skills.classifier import (
    classify,
    is_noise,
)
# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES
# role_family.id → lexicon vertical.  Single source of truth lives in the
# verticals registry; imported here to eliminate the drift risk.
from app.services.verticals import FAMILY_TO_LEXICON as _ROLE_FAMILY_TO_VERTICAL
from .credentials import (
    _CREDENTIAL_COMPONENT_LABELS,
    _clean_credential_phrase,
    _has_credential_marker,
    _is_au_unit_code,
    _is_fluff_phrase,
    _is_qualification_phrase,
    _is_setting_descriptor,
    _is_vehicle_eligibility,
    _looks_like_language,
    _share_content_token,
)

def _empty_sidecar() -> Dict[str, list]:
    # Keys are kept SINGULAR to match the source-of-truth NoiseT literals
    # ("credential", "eligibility", "noise") returned by `is_noise()` so the
    # sidecar can be indexed by noise_type directly without a translation map.
    return {
        "credential": [],     # phrases that resolved to noise.credential
        "eligibility": [],    # phrases that resolved to noise.eligibility
        "noise": [],          # phrases that resolved to noise.noise
        "unknown": [],        # vertical-lexicon misses (kept in LLM bucket)
        "moved": [],          # phrase moved between categories by the lexicon
        "setting_label": [],  # phrases stripped as sector/setting descriptors
    }


def post_process_skills(
    skills_by_category: Dict[str, Any],
    *,
    role_family_id: str,
) -> Tuple[Dict[str, List[str]], Dict[str, list]]:
    """Apply lexicon classification to a single skills dict.

    Input  : ``{"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}``
             (the LLM's raw output for one bucket — required or preferred).
    Output : ``(cleaned, sidecar)``.

    Resolution per phrase:
      1. Universal-noise check → if hit, route to sidecar by type and
         REMOVE from skills. Runs for every role family, including master.
      2. If a vertical lexicon applies (tech / nursing / cleaning):
         classify and either KEEP (matches LLM-assigned category) or
         MOVE (canonical category differs from LLM-assigned). The
         phrase is replaced with its canonical form.
      3. If the lexicon doesn't recognise the phrase, it stays in the
         LLM-assigned bucket and is recorded in ``sidecar.unknown``.

    Deduplication is by (canonical_lower, target_category) — so the
    same skill listed under two LLM buckets collapses to one.
    """
    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)

    cleaned: Dict[str, List[str]] = {c: [] for c in _CATEGORIES}
    sidecar = _empty_sidecar()
    seen: set = set()  # (canonical_lower, target_category)

    for cat in _CATEGORIES:
        items = skills_by_category.get(cat) or []
        if not isinstance(items, list):
            continue
        for raw in items:
            if not isinstance(raw, str):
                continue
            phrase = raw.strip()
            if not phrase:
                continue

            # 1a. Qualification / student-status phrases — always credentials.
            if _is_qualification_phrase(phrase):
                sidecar["credential"].append(_clean_credential_phrase(phrase))
                continue

            # 1a'. Australian VET unit codes (HLTHPS007, HLTAID011, CHCCCS015)
            #     — qualification components, route to credentials. Caught
            #     here before noise lookup because they're not in the static
            #     noise lexicon (there are hundreds; pattern is cleaner).
            if _is_au_unit_code(phrase):
                sidecar["credential"].append(_clean_credential_phrase(phrase))
                continue

            # 1a-veh. Vehicle / driver-licence / car-insurance JD requirements
            #     — eligibility statements, not competencies. Catches state-
            #     prefixed licences ("NSW driver's license"), vehicle-access
            #     phrases ("access to a car with third-party property
            #     insurance"), bare insurance/registration references. Caught
            #     before the static noise lookup because variants outnumber
            #     what's reasonable to enumerate by hand.
            if _is_vehicle_eligibility(phrase):
                sidecar["credential"].append(_clean_credential_phrase(phrase))
                continue

            # 1a''. Embedded credential markers — the qualification-phrase
            #      and unit-code detectors above are anchored at the START
            #      of the phrase, so they miss embedded markers like
            #      "individual support at certificate iv level" or
            #      "medication endorsement (HLTHPS007 unit)". This scan
            #      catches them anywhere in the phrase and routes to the
            #      credential sidecar so the JD-analysis display stays
            #      clean of credential leakage.
            if _has_credential_marker(phrase):
                sidecar["credential"].append(_clean_credential_phrase(phrase))
                continue

            phrase_lower = phrase.lower().strip()

            # 1a'''. Sector / setting descriptors — strip from Skills, route
            #       to setting_label sidecar. Symmetric to the CV-side
            #       _ROLE_CATEGORY_LABELS filter in eval/enforce.py.
            #       Containment check catches "residential aged care facility
            #       experience" which has trailing words beyond the bare label.
            if _is_setting_descriptor(phrase_lower):
                sidecar["setting_label"].append(phrase)
                continue

            # 1a'''-fluff. Values/motivational fluff ("making a positive
            #       difference") — drop from Skills, route to the noise sidecar.
            if _is_fluff_phrase(phrase_lower):
                sidecar["noise"].append(phrase)
                continue

            # 1a''''. Bare credential-component labels (fragments of Cert III
            #        in Individual Support / Ageing). These are NOT standalone
            #        credentials — surfacing "individual support" in the
            #        credential block produces a phantom "missing credential".
            #        Drop them to noise: out of Skills AND out of credentials.
            if phrase_lower in _CREDENTIAL_COMPONENT_LABELS:
                sidecar["noise"].append(phrase)
                continue

            # 1b. Universal noise — runs for ALL families. A phrase here
            #    is never a skill regardless of vertical.
            nt = is_noise(phrase)
            if nt is not None:
                sidecar[nt].append(phrase)
                continue

            # 1c. Language entries ("Cantonese language", "Greek-speaking")
            #     must NOT land in the clinical/care domain_knowledge bucket.
            #     Force them to `technical` (renders as Other Skills in
            #     nursing) regardless of where the LLM put them. Recorded in
            #     `moved` when category actually changed.
            if _looks_like_language(phrase):
                if cat != "technical":
                    sidecar["moved"].append({
                        "phrase": phrase,
                        "from": cat,
                        "to": "technical",
                        "canonical": phrase,
                        "match_kind": "language-pattern",
                    })
                key = (phrase.lower(), "technical")
                if key in seen:
                    continue
                seen.add(key)
                cleaned["technical"].append(phrase)
                continue

            # 2. Vertical lexicon (when applicable).
            target_cat = cat
            display = phrase
            if vertical is not None:
                c = classify(phrase, vertical)  # type: ignore[arg-type]
                if c is not None and c.is_skill:
                    target_cat = c.category  # type: ignore[assignment]
                    # For SOFT SKILLS we PRESERVE the LLM's surface phrase
                    # when the lexicon canonical is from a DIFFERENT word
                    # family (e.g. "compassion" → canonical "empathy",
                    # "flexible" → "adaptability"). Cross-family rewrites
                    # contradict the JD-analysis prompt's verbatim rule and
                    # break tailored-CV matching to the JD's actual wording.
                    #
                    # Within-family canonicalisation is still fine
                    # ("effective verbal communication" → "verbal
                    # communication"; "ability to work in a team" →
                    # "teamwork" — both share a content token).
                    if (
                        cat == "soft_skills"
                        and target_cat == "soft_skills"
                        and not _share_content_token(phrase, c.canonical)
                    ):
                        display = phrase  # preserve verbatim (cross-family)
                    else:
                        display = c.canonical
                    if target_cat != cat:
                        sidecar["moved"].append({
                            "phrase": phrase,
                            "from": cat,
                            "to": target_cat,
                            "canonical": c.canonical,
                            "match_kind": c.match_kind,
                        })
                else:
                    # 3. Unknown — keep the LLM phrase in its bucket but
                    #    flag for visibility (so the lexicon can grow).
                    sidecar["unknown"].append({"phrase": phrase, "category": cat})

            # 2b. Re-check sector / credential-component after lexicon
            # canonicalisation. The lexicon collapses variants like "home
            # care support" → canonical "home care", "individualised
            # support" → "individual support" — those canonicals are
            # exactly the labels we need to strip, but step 1a' could only
            # see the LLM's surface phrase. Catch them now.
            canon_lower = display.lower()
            if _is_setting_descriptor(canon_lower):
                sidecar["setting_label"].append(phrase)
                continue
            if canon_lower in _CREDENTIAL_COMPONENT_LABELS:
                sidecar["noise"].append(phrase)
                continue

            key = (display.lower(), target_cat)
            if key in seen:
                continue
            seen.add(key)
            cleaned[target_cat].append(display)

    return cleaned, sidecar
