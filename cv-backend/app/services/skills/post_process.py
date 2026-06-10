"""Apply lexicon classification to LLM-extracted skill lists.

Used after JD analysis (LLM) and after CV categorisation (LLM) to:

  • drop universal noise from skill buckets (eligibility / credential /
    framework noise — these are NEVER skills)
  • move mis-bucketed skills to their lexicon-correct category
  • replace surface phrasings with canonical forms (so the CV and JD
    sides agree on the same canonical entry — which is what makes
    downstream matching deterministic)
  • track what was removed/moved in a `sidecar` dict, for routing
    (credentials → Registration & Licences) and for diagnostics

The LLM still EXTRACTS phrases (variance-tolerant). The lexicon
DECIDES the category (deterministic). Unknown phrases stay in the
LLM-assigned bucket as a safe fallback rather than being guessed
into the wrong one.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.skills.classifier import (
    classify,
    is_noise,
)

# ---------------------------------------------------------------------------
# Pattern-based qualification / student-status filter
# ---------------------------------------------------------------------------
# These phrases are ALWAYS credentials/prerequisites, never a skill the
# candidate demonstrates.  A single regex is more maintainable than
# listing every "Certificate III in …" / "Diploma of …" variant explicitly.
#
# Conservative: anchored at the START so "individual support certificate"
# doesn't accidentally match.  Route to sidecar["credential"].
_QUAL_PATTERN = re.compile(
    r"^(?:"
    r"certificate\s+(?:i{1,4}|iv|[1-4]|in\b|of\b)|"     # certificate III/IV/in
    r"cert\.?\s+(?:i{1,4}|iv|[1-4]|in\b)|"               # cert III / cert. IV
    r"diploma\s+of\b|"
    r"advanced\s+diploma\b|"
    r"bachelor\s+(?:of|degree)\b|"
    r"graduate\s+(?:certificate|diploma|entry)\b|"
    r"master\s+of\b|"
    r"enrolled\s+in\b|"
    r"completion\s+of\b|"
    # "completed first year of nursing", "completed bachelor of", "completed
    # certificate IV", "completed diploma of nursing" — qualification progress.
    r"completed\s+(?:"
        r"(?:first|second|third|fourth|final|1st|2nd|3rd|4th)\s+year\b|"
        r"year\s+(?:one|two|three|four|1|2|3|4)\b|"
        r"certificate\b|cert\.?\s+(?:i{1,4}|iv|[1-4]|in\b)|"
        r"diploma\b|advanced\s+diploma\b|"
        r"bachelor\b|master\b|graduate\b|"
        r"nursing\s+course\b|nursing\s+degree\b|nursing\s+studies\b"
    r")|"
    # Bare "first year of nursing course" / "third year medical student" / etc.
    # — anchored at start. Only matches when followed by a clear qualification
    # context word ("nursing/medical/midwifery/medicine/pharmacy/allied
    # health"), so "first year of employment" stays a skill phrase (it isn't).
    r"(?:first|second|third|fourth|final|1st|2nd|3rd|4th)\s+year\s+"
    r"(?:of\s+)?"
    r"(?:nursing|medical|midwifery|medicine|pharmacy|allied\s+health)\b|"
    r"year\s+(?:one|two|three|four|1|2|3|4)\s+of\s+"
    r"(?:nursing|medical|midwifery|medicine|pharmacy|allied\s+health|"
    r"the\s+(?:nursing|medical|midwifery)\s+(?:course|degree|program))\b|"
    r"hltaid\d"                                            # HLTAID011 etc.
    r")",
    re.IGNORECASE,
)

# Student / qualification descriptions that are NOT captured by the pattern
# above but should still route to the credential sidecar.
_STUDENT_NOISE = frozenset({
    "rn student", "en student",
    "nursing student clinical skills",
    "nursing student with aged care placement",
    "nursing student with aged care placement experience",
    "overseas nursing qualification",
    "overseas qualified nurse",
    "overseas nursing registration",
    "assistant in nursing qualification",
    "enrolled nurse qualification",
    "registered nurse qualification",
    "allied health student background",
    "allied health training",
    "nursing assistance in residential aged care",
    "fundamental clinical nursing skills",
    "fundamental clinical skills",
    "health service assistance",
    "basic clinical nursing skills",
    "rn studies",
    "en studies",
    "assistant in nursing skills",
    "aged care worker skills",
})


def _is_qualification_phrase(phrase: str) -> bool:
    """True if the phrase describes a qualification/credential, not a skill."""
    lowered = phrase.strip().lower()
    if _QUAL_PATTERN.match(lowered):
        return True
    return lowered in _STUDENT_NOISE

logger = logging.getLogger(__name__)

# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
_CATEGORIES: Tuple[str, ...] = ("technical", "soft_skills", "domain_knowledge")

# role_family.id → lexicon vertical. The `master` family is the general
# fallback (unknown role): we don't apply a vertical lexicon to it, but we
# DO still apply the universal noise filter (sector-agnostic).
_ROLE_FAMILY_TO_VERTICAL: Dict[str, Optional[str]] = {
    "tech": "tech",
    "nursing": "nursing",
    "manual": "cleaning",
    "master": None,
}


def _empty_sidecar() -> Dict[str, list]:
    # Keys are kept SINGULAR to match the source-of-truth NoiseT literals
    # ("credential", "eligibility", "noise") returned by `is_noise()` so the
    # sidecar can be indexed by noise_type directly without a translation map.
    return {
        "credential": [],   # phrases that resolved to noise.credential
        "eligibility": [],  # phrases that resolved to noise.eligibility
        "noise": [],        # phrases that resolved to noise.noise
        "unknown": [],      # vertical-lexicon misses (kept in LLM bucket)
        "moved": [],        # phrase moved between categories by the lexicon
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
                sidecar["credential"].append(phrase)
                continue

            # 1b. Universal noise — runs for ALL families. A phrase here
            #    is never a skill regardless of vertical.
            nt = is_noise(phrase)
            if nt is not None:
                sidecar[nt].append(phrase)
                continue

            # 2. Vertical lexicon (when applicable).
            target_cat = cat
            display = phrase
            if vertical is not None:
                c = classify(phrase, vertical)  # type: ignore[arg-type]
                if c is not None and c.is_skill:
                    display = c.canonical
                    target_cat = c.category  # type: ignore[assignment]
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

            key = (display.lower(), target_cat)
            if key in seen:
                continue
            seen.add(key)
            cleaned[target_cat].append(display)

    return cleaned, sidecar


def post_process_jd_analysis(
    jd_analysis: Dict[str, Any],
    *,
    role_family_id: str,
) -> Dict[str, Any]:
    """Apply lexicon post-processing to a complete JD-analysis result.

    Mutates a shallow copy: ``required_skills`` and ``preferred_skills``
    are replaced with the lexicon-cleaned versions, and a new
    ``lexicon_meta`` field is attached containing the per-bucket
    sidecar (for downstream routing and diagnostics).
    """
    out = dict(jd_analysis)  # shallow copy — JSON-roundtrippable anyway

    req_clean, req_side = post_process_skills(
        out.get("required_skills") or {}, role_family_id=role_family_id,
    )
    pref_clean, pref_side = post_process_skills(
        out.get("preferred_skills") or {}, role_family_id=role_family_id,
    )

    out["required_skills"] = req_clean
    out["preferred_skills"] = pref_clean
    out["lexicon_meta"] = {
        "role_family": role_family_id,
        "vertical": _ROLE_FAMILY_TO_VERTICAL.get(role_family_id),
        "required": req_side,
        "preferred": pref_side,
    }

    # Single concise log line summarising what changed. Useful when
    # something looks off in a production run — quick to spot whether
    # the lexicon dropped/moved anything material.
    n_dropped = (len(req_side["credential"]) + len(req_side["eligibility"]) + len(req_side["noise"])
                 + len(pref_side["credential"]) + len(pref_side["eligibility"]) + len(pref_side["noise"]))
    n_moved = len(req_side["moved"]) + len(pref_side["moved"])
    n_unknown = len(req_side["unknown"]) + len(pref_side["unknown"])
    if n_dropped or n_moved or n_unknown:
        logger.info(
            "lexicon post-process (family=%s): dropped %d non-skill, moved %d, %d unknown",
            role_family_id, n_dropped, n_moved, n_unknown,
        )

    return out


def post_process_cv_skills(
    cv_skills: Dict[str, Any],
) -> Tuple[Dict[str, List[str]], Dict[str, list]]:
    """CV-side variant: apply ONLY the universal-noise filter.

    The CV categoriser produces buckets without knowing the vertical
    (it's run at upload time, no JD context). Applying a vertical
    lexicon here would require guessing the candidate's primary
    vertical — the LLM already does a decent job on the CV side
    (current symptom of the bug is on the JD side). So we just strip
    universal noise (credentials/eligibility/values) and trust the
    LLM's bucketing. Dedupes case-insensitively.

    Sidecar shape matches ``post_process_skills`` (credentials /
    eligibility / noise populated; moved + unknown stay empty
    because no vertical lexicon was applied).
    """
    cleaned: Dict[str, List[str]] = {c: [] for c in _CATEGORIES}
    sidecar = _empty_sidecar()
    seen: set = set()
    for cat in _CATEGORIES:
        items = cv_skills.get(cat) or []
        if not isinstance(items, list):
            continue
        for raw in items:
            if not isinstance(raw, str):
                continue
            phrase = raw.strip()
            if not phrase:
                continue
            nt = is_noise(phrase)
            if nt is not None:
                sidecar[nt].append(phrase)
                continue
            key = (phrase.lower(), cat)
            if key in seen:
                continue
            seen.add(key)
            cleaned[cat].append(phrase)
    return cleaned, sidecar
