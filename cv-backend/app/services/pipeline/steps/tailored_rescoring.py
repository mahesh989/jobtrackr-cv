"""
Step 6.5 — Tailored-CV re-scoring (deterministic).

After the tailored CV is generated, we want to verify — without another
AI call — whether the keywords the feasibility classifier APPROVED were
actually surfaced in the tailored markdown, and what the resulting ATS
score is.

Approach:
  1. For every keyword in feasibility_plan.inject_directly + .inject_as_extension,
     check whether it appears in the tailored CV text (case-insensitive
     substring on word-boundaries-ish — same level of fuzziness as the
     ATS step uses for section-name detection).
  2. Build a `tailored_matching` structure by taking the original
     `matching` and MOVING the verified keywords from `missed` to
     `matched`, then recomputing `counts` and `match_rates`.
  3. Run the deterministic ATS scorer on `(tailored_text, jd, tailored_matching)`.
  4. Report the lift.

Why deterministic?
  - It is honest. We only credit lift for keywords that LITERALLY appear
    in the tailored CV. If the AI failed to inject something, no credit.
  - It avoids a second cv_jd_matching AI call, halving the per-run cost
    and latency for this verification step.
  - It is reproducible by hand, which the user wants for ATS transparency.

Output:
    {
      "tailored_ats_scoring_result": {<full breakdown>, ...},
      "tailored_match_score":         int,         # 0-100
      "ats_lift":                     int,         # tailored - original
      "injected_keywords":            [str, ...],  # actually present in tailored
      "failed_to_inject":             [str, ...],  # approved but missing
      "honest_gaps":                  [str, ...],  # echo from feasibility
      "fabricated_keywords":          [str, ...],  # cannot_inject keywords that
                                                   # appeared in the tailored CV
                                                   # (prompt violation — should be empty)
    }
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Set, Tuple

from app.services.pipeline.steps.ats_scoring import (
    _FORMATTING_MAX,
    _to_pct,
    run_ats_scoring,
)
from app.services.pipeline.steps.cv_jd_matching import (
    _compute_counts,
    _compute_match_rates,
)

logger = logging.getLogger(__name__)


_BUCKETS = ("required", "preferred")
_CATEGORIES = ("technical", "soft_skills", "domain_knowledge")


def run_tailored_rescoring(
    tailored_markdown: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    feasibility: Dict[str, Any],
    original_ats: Dict[str, Any],
) -> Dict[str, Any]:
    plan = (feasibility or {}).get("feasibility_plan") or {}
    approved = _approved_keywords(plan)

    tailored_lower = (tailored_markdown or "").lower()

    # Honesty blocklist: keywords the feasibility classifier judged we cannot
    # legitimately claim. Surfacing one of these is a fabrication and is NEVER
    # credited toward the score.
    honest_gaps = [
        str(e.get("keyword") or "").lower().strip()
        for e in (plan.get("cannot_inject") or [])
        if isinstance(e, dict) and e.get("keyword")
    ]
    blocked: Set[str] = {kw for kw in honest_gaps if kw}

    # Credit EVERY missed JD keyword the tailored CV now surfaces literally,
    # except the honesty blocklist. Reacting to any genuine improvement — not
    # only the keywords the feasibility classifier happened to enumerate — is
    # what makes this generalise across every analysis. The promotion is
    # monotonic (missed → matched only): the tailored CV can never score below
    # the original on keyword coverage.
    all_missed = _all_missed_keywords(matching)
    credited: Set[str] = {
        kw for kw in all_missed
        if kw and kw not in blocked and _kw_present(kw, tailored_lower)
    }

    # Reporting split for the UI chips: which approved keywords actually landed,
    # which were DELIBERATELY filtered as PURE sector / setting / filler junk
    # (would never have helped ATS regardless of section), and which the writer
    # genuinely failed to surface.
    #
    # Tight predicate: only the exact blocklist (sector names, JD verb-phrase
    # fragments) counts as "filtered as non-skill". The broader regex catches
    # credentials too ("First Aid Certificate", "Covid Vaccination", "NSW C
    # Class Driver Licence") which are REAL content — they just belong in
    # Registration & Licences, not Skills. When a credential keyword fails to
    # match (synonym mismatch CV-vs-JD wording), report it as genuinely missed
    # so the user knows the writer/verifier needs improvement. Phase 2 synonym
    # work will close that gap.
    from app.services.eval.writers import _NON_SKILL_EXACT, _NON_SKILL_PREFIXES

    def _is_sector_only_phrase(kw: str) -> bool:
        t = (kw or "").strip().lower()
        if not t:
            return False
        if t in _NON_SKILL_EXACT:
            return True
        for prefix in _NON_SKILL_PREFIXES:
            if t.startswith(prefix):
                return True
        return False

    injected = sorted(credited)
    _failed_raw = {kw for kw in approved if kw not in credited}
    filtered_non_skill = sorted({kw for kw in _failed_raw if _is_sector_only_phrase(kw)})
    failed = sorted(_failed_raw - set(filtered_non_skill))

    # Build a tailored matching by promoting the credited keywords.
    tailored_matching = _promote_injections(matching, credited)

    # Recompute counts + rates against the JD as ground truth.
    tailored_matching["counts"] = _compute_counts(
        tailored_matching["matched"], jd_analysis
    )
    tailored_matching["match_rates"] = _compute_match_rates(
        tailored_matching["counts"]
    )

    # Deterministic ATS score on the tailored CV, using the SAME scorer and the
    # SAME (frozen) experience signal as the original. raw_match_score rides
    # through _promote_injections untouched, so Category 2 (experience) is
    # identical for original and tailored — honest tailoring surfaces keywords,
    # it does not add experience. Only keyword coverage moves.
    tailored_ats = run_ats_scoring(tailored_markdown, jd_analysis, tailored_matching)

    # Formatting is a property of the GENERATOR, not of tailoring quality. A
    # clean generated CV must never format worse than the raw original (which
    # can happen only as an artifact — e.g. contact info not stamped). Floor the
    # formatting component at the original's so such artifacts can't manufacture
    # a phantom regression; genuinely cleaner formatting is still rewarded.
    tailored_ats = _floor_formatting(tailored_ats, original_ats)

    original_score = int((original_ats or {}).get("overall_score") or 0)
    tailored_score = int(tailored_ats.get("overall_score") or 0)
    lift = tailored_score - original_score

    # Fabrication check — if any blocked keyword LITERALLY appears in the
    # tailored CV, the writer broke the honesty contract. Surface it so the
    # user can see what was wrongly added; it earns no points and doesn't fail
    # the run.
    #
    # Uses LITERAL match (no synonyms / suffix-strip) — Phase 2B added a
    # credential-synonym map to _kw_present, which the credit path needs but
    # the fabrication path explicitly must NOT use. The conflict surfaced on
    # the Anglicare run: feasibility flagged CPR as an honest gap (no literal
    # CPR in CV), Phase 2B synonyms credited CPR via HLTAID011 in tailored
    # CV, fabrication check then flagged CPR as fabricated → user sees same
    # keyword in both honest-gap AND fabricated lists, which is contradictory.
    # The right answer: 'CPR' wasn't fabricated, the tailored CV literally
    # says 'First Aid (HLTAID011)'. Equivalence ≠ fabrication.
    fabricated: List[str] = sorted(
        {kw for kw in blocked if _literal_match(kw, tailored_lower)}
    )
    if fabricated:
        logger.warning(
            "Tailored CV contains %d fabricated keyword(s) from cannot_inject: %s",
            len(fabricated),
            fabricated,
        )

    return {
        "tailored_ats_scoring_result": tailored_ats,
        "tailored_match_score":         tailored_score,
        "ats_lift":                     lift,
        "injected_keywords":            injected,
        "failed_to_inject":             failed,
        "filtered_as_non_skill":        filtered_non_skill,
        "honest_gaps":                  honest_gaps,
        "fabricated_keywords":          fabricated,
        "tailored_matching":            tailored_matching,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _all_missed_keywords(matching: Dict[str, Any]) -> Set[str]:
    """Flatten matching['missed'] across every bucket × category to a lower-cased set."""
    missed = (matching or {}).get("missed") or {}
    out: Set[str] = set()
    if not isinstance(missed, dict):
        return out
    for bucket in _BUCKETS:
        b = missed.get(bucket) or {}
        if not isinstance(b, dict):
            continue
        for cat in _CATEGORIES:
            for kw in (b.get(cat) or []):
                k = str(kw).lower().strip()
                if k:
                    out.add(k)
    return out


def _floor_formatting(
    tailored_ats: Dict[str, Any], original_ats: Dict[str, Any]
) -> Dict[str, Any]:
    """Raise the tailored formatting component to at least the original's.

    Mutates and returns the tailored ATS dict: when the original formatted
    better, the shortfall is added back to the formatting component, the
    formatting_score percentage, and the overall_score. A no-op when the
    tailored CV already formats as well or better.
    """
    t_fmt = (tailored_ats.get("breakdown") or {}).get("category_3_formatting") or {}
    o_fmt = ((original_ats or {}).get("breakdown") or {}).get("category_3_formatting") or {}
    t_earned = float(t_fmt.get("earned") or 0.0)
    o_earned = float(o_fmt.get("earned") or 0.0)
    if o_earned <= t_earned:
        return tailored_ats

    delta = o_earned - t_earned
    t_fmt["earned"] = round(o_earned, 1)
    tailored_ats["formatting_score"] = _to_pct(o_earned, _FORMATTING_MAX)
    new_overall = int(round((tailored_ats.get("overall_score") or 0) + delta))
    tailored_ats["overall_score"] = max(0, min(100, new_overall))
    return tailored_ats


def _approved_keywords(plan: Dict[str, Any]) -> List[str]:
    """All keywords the feasibility classifier said are eligible to inject."""
    out: List[str] = []
    for fb in ("inject_directly", "inject_as_extension", "inject_with_inference"):
        for entry in plan.get(fb) or []:
            if not isinstance(entry, dict):
                continue
            kw = str(entry.get("keyword") or "").lower().strip()
            if kw:
                out.append(kw)
    # de-dup, preserve order
    seen: Set[str] = set()
    deduped: List[str] = []
    for kw in out:
        if kw not in seen:
            seen.add(kw)
            deduped.append(kw)
    return deduped


# Credential / qualification suffix words. When a JD asks for "First Aid
# Certificate" the candidate's CV will typically list "First Aid (HLTAID011)"
# — same credential, different wording. We retry the match with the suffix
# word stripped so the verifier correctly credits the keyword.
_CREDENTIAL_SUFFIXES = (
    "certificate", "certification", "certified",
    "licence", "license", "licensed",
    "vaccination", "vaccinated",
    "check", "clearance",
)

# Sprint I — JD-side qualifier words that decorate a credential without
# changing what it IS. AU JDs commonly prepend 'current', 'valid',
# 'accredited', etc. before credential names ('current accredited first
# aid certificate'). These prefixes prevent the synonym map (which keys
# on the bare credential name) from matching. Strip them before lookup.
_CREDENTIAL_PREFIX_QUALIFIERS = (
    "current",
    "valid",
    "accredited",
    "latest",
    "up-to-date",
    "up to date",
    "active",
    "recent",
    "renewed",
    "in-date",
    "in date",
)


def _strip_credential_qualifiers(kw: str) -> str:
    """Strip leading JD qualifier words from a credential keyword.

    'current accredited first aid certificate' → 'first aid certificate'
    'valid driver's licence' → 'driver's licence'

    Idempotent: re-running has no further effect. Returns the original
    keyword when no qualifier prefix is found.
    """
    cleaned = kw.strip()
    changed = True
    while changed:
        changed = False
        low = cleaned.lower()
        for q in _CREDENTIAL_PREFIX_QUALIFIERS:
            if low.startswith(q + " "):
                cleaned = cleaned[len(q):].lstrip()
                changed = True
                break
    return cleaned


# Phase 2B — conservative credential synonym map.
#
# Maps JD-side phrasings (lowercased, no punctuation) to ALTERNATIVE CV-side
# tokens that mean the SAME underlying credential by Australian standards.
# Verifier credits the keyword if ANY synonym appears literally in the
# tailored markdown.
#
# Curated for honesty: every pair is an equivalence any AU aged-care
# recruiter would accept. Excluded:
#   • Different credentials (NDIS Workers Check ≠ Police Check)
#   • Different populations (disability ≠ aged care)
#   • Soft-skill morphology (commitment ↔ "Dedicated" — too noisy)
#
# Sources of equivalence:
#   • NSW road authority: 'C class' = unrestricted car licence in NSW;
#     "Driver Licence" / "Driver's Licence" all refer to the same credential.
#   • Australian VET system: HLTAID011 ("Provide First Aid") is the current
#     national First Aid qualification AND explicitly includes CPR
#     competency (supersedes the older standalone HLTAID009 "Provide CPR").
#     Holding HLTAID011 demonstrably means you can perform CPR.
#   • Vaccine naming: "Flu" / "Influenza" are the same vaccine — used
#     interchangeably by AU clinical settings.
#   • Working rights: AU profile-stamped credentials are equivalent to JD
#     phrasings like "Australian work rights".
_KW_SYNONYM_MAP: Dict[str, List[str]] = {
    # ── Driver licence variants ──────────────────────────────────────────
    # JD wording → CV-equivalent phrasings. NSW C-class = the unrestricted
    # car licence held by adults. "Open" = unrestricted Australian licence.
    "nsw c class motor vehicle licence": [
        "driver licence", "drivers licence", "driver's licence",
        "drivers license", "driver license", "driver's license",
        "car licence", "car license",
    ],
    "nsw c class driver licence": [
        "driver licence", "drivers licence", "driver's licence",
        "drivers license", "driver license", "driver's license",
    ],
    "c class motor vehicle licence": [
        "driver licence", "drivers licence", "driver's licence",
    ],
    "motor vehicle licence": [
        "driver licence", "drivers licence", "driver's licence",
    ],
    "driving nsw c class motor vehicle": [
        "driver licence", "drivers licence", "driver's licence",
    ],

    # Bare "australian driver's licence" (no NSW C-class prefix) — common
    # JD phrasing across Aus job boards. Apostrophe and American spelling
    # variants both covered.
    "valid australian driver's license": [
        "driver licence", "drivers licence", "driver's licence",
        "driver license", "drivers license", "driver's license",
    ],
    "valid australian drivers license": [
        "driver licence", "drivers licence", "driver's licence",
        "driver license", "drivers license", "driver's license",
    ],
    "valid australian driver licence": [
        "driver licence", "drivers licence", "driver's licence",
    ],
    "australian driver's license": [
        "driver licence", "drivers licence", "driver's licence",
        "driver license", "drivers license", "driver's license",
    ],
    "australian drivers license": [
        "driver licence", "drivers licence", "driver's licence",
    ],
    "australian driver licence": [
        "driver licence", "drivers licence", "driver's licence",
    ],
    "driver's license": [
        "driver licence", "drivers licence", "driver's licence",
    ],
    "drivers license": [
        "driver licence", "drivers licence", "driver's licence",
    ],

    # ── First Aid (HLTAID011) ────────────────────────────────────────────
    # HLTAID011 is the current AU "Provide First Aid" qualification.
    "first aid certificate": [
        "first aid", "first aid (hltaid011)", "hltaid011", "hltaid",
    ],
    "first aid certification": [
        "first aid", "first aid (hltaid011)", "hltaid011", "hltaid",
    ],

    # ── CPR (covered by HLTAID011) ───────────────────────────────────────
    # HLTAID011 explicitly INCLUDES CPR competency. AU aged-care recruiters
    # accept First Aid (HLTAID011) as proof of CPR ability — standalone
    # HLTAID009 "Provide CPR" is the older unit that HLTAID011 supersedes.
    "cpr certificate": [
        "first aid (hltaid011)", "hltaid011", "cpr",
    ],
    "cpr certification": [
        "first aid (hltaid011)", "hltaid011", "cpr",
    ],

    # ── Vaccinations ─────────────────────────────────────────────────────
    # AU clinical settings use "Flu" and "Influenza" interchangeably.
    "flu vaccination": [
        "influenza vaccination", "flu vaccine", "influenza vaccine",
    ],
    "influenza vaccination": [
        "flu vaccination", "flu vaccine", "influenza vaccine",
    ],

    # ── Working rights ───────────────────────────────────────────────────
    "australian working rights": [
        "work rights", "right to work", "permanent resident",
        "australian citizen", "australian working rights",
    ],
    "australian work rights": [
        "work rights", "right to work", "permanent resident",
        "australian citizen",
    ],
    "working rights": ["work rights", "right to work"],

    # ── Police check ─────────────────────────────────────────────────────
    "police check": ["national police check", "police clearance"],
    "national police check": ["police check", "police clearance"],
}


def _kw_present(keyword: str, text_lower: str) -> bool:
    """
    Detect a keyword in the tailored CV text.

    Strategy:
      1. Literal word-boundary match (the common case).
      2. If the keyword ends in a credential-suffix word ("certificate",
         "licence", "vaccination"...), retry with the suffix stripped.
         "First Aid Certificate" → "First Aid" matches "First Aid (HLTAID011)".
      3. If the keyword contains " and " or " & ", split into parts and
         require EVERY part to be present. "Covid and Flu Vaccination" →
         requires both "Covid Vaccination" and "Flu Vaccination" (suffix
         appended to each bare token).
    """
    kw = keyword.lower().strip()
    if not kw:
        return False

    if _literal_match(kw, text_lower):
        return True

    # Sprint I — strip JD qualifier-prefix words ('current', 'valid',
    # 'accredited', etc.) and re-run the entire matcher on the stripped
    # form. 'current accredited first aid certificate' → 'first aid
    # certificate' → suffix-strip / synonym lookup. Only retries when
    # something was actually stripped (avoids infinite recursion).
    stripped = _strip_credential_qualifiers(kw)
    if stripped != kw and stripped:
        if _literal_match(stripped, text_lower):
            return True
        # Suffix-strip on the qualifier-stripped form too.
        sparts = stripped.split()
        if len(sparts) >= 2 and sparts[-1] in _CREDENTIAL_SUFFIXES:
            bare_stripped = " ".join(sparts[:-1])
            if _literal_match(bare_stripped, text_lower):
                return True
        # Synonym lookup on stripped form.
        syns_stripped = _KW_SYNONYM_MAP.get(stripped)
        if syns_stripped:
            for syn in syns_stripped:
                if _literal_match(syn, text_lower):
                    return True

    # Suffix-strip retry for credentials.
    parts = kw.split()
    if len(parts) >= 2 and parts[-1] in _CREDENTIAL_SUFFIXES:
        bare = " ".join(parts[:-1])
        if _literal_match(bare, text_lower):
            return True

    # Phase 2B — credential synonym map. JD-side phrasing → CV-side
    # equivalent term(s). Honest by curation: every entry is an
    # equivalence any AU aged-care recruiter would accept (e.g. NSW C
    # class motor vehicle licence ≡ Driver Licence; First Aid Certificate
    # ≡ First Aid HLTAID011; HLTAID011 covers CPR by inclusion).
    synonyms = _KW_SYNONYM_MAP.get(kw)
    if synonyms:
        for syn in synonyms:
            if _literal_match(syn, text_lower):
                return True

    # Conjunction split: "covid and flu vaccination" → "covid vaccination"
    # AND "flu vaccination" — both must be present.
    for sep in (" and ", " & "):
        if sep in kw:
            # Detect a trailing shared suffix (vaccination / certificate / ...)
            tokens = kw.split()
            shared_suffix = ""
            if tokens[-1] in _CREDENTIAL_SUFFIXES:
                shared_suffix = " " + tokens[-1]
                kw_core = " ".join(tokens[:-1])
            else:
                kw_core = kw
            sub_parts = [p.strip() for p in kw_core.split(sep) if p.strip()]
            if len(sub_parts) >= 2 and all(
                _literal_match(p + shared_suffix, text_lower) or _literal_match(p, text_lower)
                for p in sub_parts
            ):
                return True
            break  # only try the first separator that's present

    return False


def _literal_match(kw: str, text_lower: str) -> bool:
    """Word-boundary regex match for word-only keywords; substring for the rest."""
    if not kw:
        return False
    if re.fullmatch(r"[\w\s\-]+", kw):
        pattern = r"\b" + re.escape(kw) + r"\b"
        return re.search(pattern, text_lower) is not None
    return kw in text_lower


def _promote_injections(
    matching: Dict[str, Any], injected: Set[str]
) -> Dict[str, Any]:
    """
    Return a new matching dict with `matched`/`missed` updated:
    every injected keyword is moved from missed → matched, in the
    same bucket × category it originated from.
    """
    src_matched = (matching or {}).get("matched") or {}
    src_missed  = (matching or {}).get("missed")  or {}

    new_matched: Dict[str, Dict[str, List[str]]] = {b: {c: [] for c in _CATEGORIES} for b in _BUCKETS}
    new_missed:  Dict[str, Dict[str, List[str]]] = {b: {c: [] for c in _CATEGORIES} for b in _BUCKETS}

    for bucket in _BUCKETS:
        m_bucket = (src_matched.get(bucket) or {}) if isinstance(src_matched, dict) else {}
        x_bucket = (src_missed.get(bucket)  or {}) if isinstance(src_missed,  dict) else {}
        for cat in _CATEGORIES:
            already_matched = list(m_bucket.get(cat) or [])
            still_missing:  List[str] = []
            promoted:       List[str] = []
            for kw in (x_bucket.get(cat) or []):
                k = str(kw).lower().strip()
                if k in injected:
                    promoted.append(k)
                else:
                    still_missing.append(k)
            new_matched[bucket][cat] = sorted(set(already_matched + promoted))
            new_missed[bucket][cat]  = sorted(set(still_missing))

    out = dict(matching or {})
    out["matched"] = new_matched
    out["missed"]  = new_missed
    return out
