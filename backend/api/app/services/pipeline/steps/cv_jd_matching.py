"""Step 2 — CV-JD matching. Compares CV text to the JD analysis.

Output schema (nested, mirrors jd_analysis):

    {
      "matched": {
        "required":  {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]},
        "preferred": {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}
      },
      "missed": {
        "required":  {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]},
        "preferred": {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}
      },
      "match_evidence": {keyword: "phrase from CV", ...},
      "matched_responsibilities": [str, ...],
      "experience_alignment": str,
      "raw_match_score": int (0-100),
      "counts": {                        # derived, never trusted from the AI
        "required":  {"technical": {"matched": int, "total": int}, ...},
        "preferred": {"technical": {"matched": int, "total": int}, ...},
        "totals":    {"matched": int, "total": int}
      },
      "match_rates": {                   # derived
        "technical_pct": float,
        "soft_skills_pct": float,
        "domain_knowledge_pct": float,
        "required_pct": float,
        "preferred_pct": float,
        "overall_pct": float
      },
      "credentials_required": {          # credential gap report (no LLM)
        "required":    [str, ...],       # from jd_analysis["credentials"] (+regex fallback)
        "preferred":   [str, ...],
        "eligibility": [str, ...],
        "present":     [str, ...],       # satisfied by CV text or user profile
        "missing":     [str, ...]        # required/preferred/eligibility not satisfied
      }
    }
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    CV_JD_MATCHING_SYSTEM,
    CV_JD_MATCHING_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)


_TOP_LEVEL_KEYS = {
    "matched",
    "missed",
    "matched_responsibilities",
    "experience_alignment",
    "raw_match_score",
}
_BUCKETS = ("required", "preferred")
_CATEGORIES = ("technical", "soft_skills", "domain_knowledge")


async def run_cv_jd_matching(
    client: AIClient,
    cv_text: str,
    jd_analysis: Dict[str, Any],
    contact_details: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    user_prompt = CV_JD_MATCHING_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(jd_analysis, indent=2),
    )
    result = await client.complete_json(
        system=CV_JD_MATCHING_SYSTEM, user=user_prompt, max_tokens=2048, temperature=0.1
    )

    missing = _TOP_LEVEL_KEYS - set(result.keys())
    if missing:
        raise ValueError(
            f"CV-JD matching response missing required keys: {sorted(missing)}"
        )

    # Normalise the nested matched/missed blocks to the canonical shape.
    result["matched"] = _normalise_match_block(result.get("matched"), name="matched")
    result["missed"] = _normalise_match_block(result.get("missed"), name="missed")

    # Reconcile against the JD: every JD keyword should appear in matched OR missed
    # exactly once, in the same bucket+category. Any drift is corrected by
    # forcing un-accounted JD keywords into "missed". This makes the counts
    # truthful even when the model loses track.
    _reconcile_with_jd(result, jd_analysis)

    # Credential sidecar — pull credential-shaped JD requirements out of
    # matched/missed before any scoring/feasibility logic runs. JD analysis
    # routinely mis-buckets `police clearance compliance`, `ndis worker
    # clearance compliance`, `medication endorsement (HLTHPS007)`, and
    # `cert iv aged care` as Care Skills; the lexicon noise list now catches
    # most of them as exact strings, but this regex is the safety net.
    # See _extract_credential_sidecar.
    credentials_sidecar = _extract_credential_sidecar(result["matched"], result["missed"])

    # Build the credential gap report. Primary source is the deterministic
    # jd_analysis["credentials"] block (Phase 6/8 JD-text scan); the regex
    # sidecar above is folded in as a fallback for LLM-mis-bucketed credentials.
    # Each credential is marked present (literal CV match or profile credential)
    # or missing — so required credentials stripped from the skill buckets (e.g.
    # "Cert III in Ageing Support") are still checked against the CV.
    credentials_required = _build_credentials_gap(
        jd_analysis, credentials_sidecar, cv_text, contact_details,
    )
    if any(credentials_required[k] for k in ("required", "preferred", "eligibility")):
        result["credentials_required"] = credentials_required
        logger.info(
            "CV-JD matching: credential gap — %d present, %d missing (required=%s)",
            len(credentials_required["present"]),
            len(credentials_required["missing"]),
            credentials_required["required"],
        )

    # Verify the AI's match_evidence: if it quoted a CV phrase that doesn't
    # actually appear in cv_text, the match was hallucinated. Demote that
    # keyword from matched → missed. Pure substring check, no LLM. The
    # subsequent _promote_literal_matches step can still bring it back if
    # the keyword itself literally appears elsewhere in the CV.
    evidence_demoted = _verify_match_evidence(
        result["matched"], result["missed"], result.get("match_evidence") or {}, cv_text,
    )
    if evidence_demoted:
        result["evidence_demoted"] = evidence_demoted
        logger.info(
            "CV-JD matching: demoted %d keyword(s) — quoted evidence not in CV: %s",
            len(evidence_demoted), evidence_demoted,
        )

    # Deterministic exact-string promotion: an AI matcher will occasionally miss
    # a JD keyword that literally appears in the CV text (observed: JD asks for
    # "communication", CV lists "communication" verbatim, AI returns it as
    # missed). Word-boundary substring search in cv_text — if found, promote
    # from missed → matched. No inference, no synonyms, no LLM call.
    literal_promoted = _promote_literal_matches(
        result["matched"], result["missed"], cv_text,
    )
    if literal_promoted:
        result["literal_promoted"] = literal_promoted
        logger.info(
            "CV-JD matching: promoted %d keyword(s) via literal CV text match: %s",
            len(literal_promoted), literal_promoted,
        )

    # Promote JD keywords the CV honestly satisfies under the role family's
    # equivalence + qualification-hierarchy rules (e.g. a higher aged-care
    # certificate subsumes a lower or alternative one the JD lists) from
    # missed → matched, so an either/or or lower-level requirement isn't flagged
    # as a gap. Deterministic and honesty-preserving — never invents a match.
    from app.services.eval.role_families import (
        promote_matched_equivalents,
        resolve_role_family,
    )
    _rf = resolve_role_family(None, jd_analysis)
    promoted = promote_matched_equivalents(
        result["matched"], result["missed"], cv_text, _rf,
    )
    if promoted:
        result["equivalence_promoted"] = promoted
        logger.info(
            "CV-JD matching: promoted %d keyword(s) via %s equivalence/hierarchy: %s",
            len(promoted), _rf.id, promoted,
        )

    # Promote missed keywords that the user's profile already satisfies
    # (police check, work rights, first aid, vaccination, etc.) from
    # missed → matched, so the matching panel agrees with the feasibility
    # plan ("Stamps from user profile credentials settings").
    if contact_details:
        from app.services.pipeline.steps.keyword_feasibility import user_has_credential
        cred_promoted = _promote_profile_credentials(
            result["matched"], result["missed"], contact_details, user_has_credential,
        )
        if cred_promoted:
            result["credential_promoted"] = cred_promoted
            logger.info(
                "CV-JD matching: promoted %d keyword(s) via profile credentials: %s",
                len(cred_promoted), cred_promoted,
            )

    # Derived counts and rates — computed by us, not the AI.
    result["counts"] = _compute_counts(result["matched"], jd_analysis)
    result["match_rates"] = _compute_match_rates(result["counts"])

    # Auxiliary fields
    result["matched_responsibilities"] = [
        str(r).strip()
        for r in (result.get("matched_responsibilities") or [])
        if str(r).strip()
    ]
    result["experience_alignment"] = str(result.get("experience_alignment") or "").strip()
    result["raw_match_score"] = _clamp_int(result.get("raw_match_score"))

    # match_evidence — keep only string→string entries
    raw_ev = result.get("match_evidence") or {}
    result["match_evidence"] = {
        str(k).lower().strip(): str(v).strip()
        for k, v in raw_ev.items()
        if str(k).strip() and str(v).strip()
    } if isinstance(raw_ev, dict) else {}

    return result


# ---------------------------------------------------------------------------
# Evidence verification + literal-string promotion
# ---------------------------------------------------------------------------


import re as _re


def _verify_match_evidence(
    matched: Dict[str, Dict[str, List[str]]],
    missed: Dict[str, Dict[str, List[str]]],
    match_evidence: Dict[str, str],
    cv_text: str,
) -> List[str]:
    """Demote AI-matched keywords whose quoted CV evidence isn't actually in the CV.

    The AI matcher returns ``match_evidence: {keyword: "<quoted CV phrase>"}``.
    Downstream steps (feasibility, scoring, writer) trust that quotation as
    proof of capability. When the AI hallucinates the evidence — quoting a
    phrase the CV doesn't contain — every downstream step compounds the lie.

    We do a case-insensitive substring check of the quoted phrase against
    cv_text. If the quote does NOT appear in the CV, the keyword is demoted
    from matched → missed. ``_promote_literal_matches`` runs immediately
    after and will re-promote any keyword whose literal string IS in the CV
    (so we only lose hallucinated matches, not true ones).

    No evidence quoted → no verification possible → no demotion (conservative).
    Short evidence (< 4 chars) is skipped to avoid false demotions on
    abbreviations.

    Mutates matched/missed in-place. Returns the list of demoted keywords.
    """
    if not match_evidence or not cv_text:
        return []
    cv_lower = cv_text.lower()
    # The AI may emit match_evidence with original-case keys ("Python":
    # "..."); matched keywords are already lowercased by _normalise_match_block.
    # Normalise the dict keys here so lookups don't silently miss.
    ev_by_key = {
        str(k).lower().strip(): str(v or "")
        for k, v in match_evidence.items()
        if str(k).strip()
    }
    demoted: List[str] = []

    for bucket in _BUCKETS:
        for cat in _CATEGORIES:
            still_matched: List[str] = []
            for kw in matched[bucket][cat]:
                evidence = ev_by_key.get(kw, "")
                ev = (evidence or "").strip().lower()
                # Skip when no evidence or too short to verify reliably.
                if not ev or len(ev) < 4:
                    still_matched.append(kw)
                    continue
                if ev in cv_lower:
                    still_matched.append(kw)
                else:
                    missed[bucket][cat].append(kw)
                    demoted.append(kw)
            matched[bucket][cat] = still_matched
    return demoted


def _promote_literal_matches(
    matched: Dict[str, Dict[str, List[str]]],
    missed: Dict[str, Dict[str, List[str]]],
    cv_text: str,
) -> List[str]:
    """Promote missed JD keywords that literally appear in the CV text.

    The AI matcher is sometimes wrong on exact-string matches (e.g. JD has
    "communication", CV has "communication", AI marks it missed). This pass
    is deterministic: case-insensitive word-boundary regex over cv_text.
    Catches the trivial-equality misses without touching the AI's judgement
    on harder cases.

    Mutates matched/missed in-place. Returns the list of promoted keywords.
    """
    if not cv_text:
        return []
    promoted: List[str] = []

    for bucket in _BUCKETS:
        for cat in _CATEGORIES:
            still_missed: List[str] = []
            for kw in missed[bucket][cat]:
                if _literal_match_in_text(kw, cv_text):
                    matched[bucket][cat].append(kw)
                    promoted.append(kw)
                else:
                    still_missed.append(kw)
            missed[bucket][cat] = still_missed
    return promoted


def _literal_match_in_text(keyword: str, cv_text: str) -> bool:
    """Word-boundary case-insensitive search for keyword in cv_text.

    Word boundaries prevent false positives like "ai" matching "fair".
    Punctuation in keyword (e.g. "ci/cd", "c++") is escaped.
    Accepts raw (mixed-case) or pre-lowered cv_text — always lowercases both.
    """
    kw = (keyword or "").strip().lower()
    if not kw:
        return False
    pattern = r"\b" + _re.escape(kw) + r"\b"
    return _re.search(pattern, cv_text.lower()) is not None


# Australian VET qualification ladder. A higher AQF level in the same vocational
# family subsumes a lower one — completing a Certificate IV in Ageing Support
# embeds the Certificate III in Individual Support, so a JD asking for the Cert
# III is satisfied by a CV holding the Cert IV (or a Diploma / Bachelor).
_QUAL_LEVEL_PATTERNS: List[Tuple[Any, int]] = [
    (_re.compile(r"\bbachelor\b"), 7),
    (_re.compile(r"\badvanced\s+diploma\b"), 6),
    (_re.compile(r"\bdiploma\b"), 5),
    (_re.compile(r"\b(?:certificate|cert\.?)\s*(?:iv|4)\b"), 4),
    (_re.compile(r"\b(?:certificate|cert\.?)\s*(?:iii|3)\b"), 3),
    (_re.compile(r"\b(?:certificate|cert\.?)\s*(?:ii|2)\b"), 2),
    (_re.compile(r"\b(?:certificate|cert\.?)\s*(?:i|1)\b"), 1),
]

# Vocational family the ladder applies to (aged / community / disability care).
# A Cert IV in *Cleaning* must NOT subsume a Cert III in Individual Support, so
# both the requirement and the CV qualification must sit in this family.
_CARE_QUAL_FAMILY: Tuple[str, ...] = (
    "individual support", "ageing", "aged care", "aged-care",
    "community service", "disability", "home and community", "personal care",
)


def _qual_level(text: str) -> int:
    """Highest AQF qualification level named in *text* (0 if none)."""
    for pat, level in _QUAL_LEVEL_PATTERNS:
        if pat.search(text):
            return level
    return 0


def _in_care_qual_family(text: str) -> bool:
    return any(fam in text for fam in _CARE_QUAL_FAMILY)


def _qualification_subsumed_by_cv(phrase: str, cv_text: str) -> bool:
    """True when a required care qualification is met by an equal-or-higher CV
    qualification in the same family (Cert IV in Ageing Support ⊇ Cert III in
    Individual Support)."""
    pl = (phrase or "").lower()
    req_level = _qual_level(pl)
    if req_level == 0 or not _in_care_qual_family(pl):
        return False
    # Scan the CV line-by-line so the level is tied to a care-family line, not a
    # stray higher qualification elsewhere (e.g. a Bachelor of Science).
    for line in (cv_text or "").lower().splitlines():
        if _in_care_qual_family(line) and _qual_level(line) >= req_level:
            return True
    return False


# ---------------------------------------------------------------------------
# Profile credential promotion
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Credential sidecar — JD analysis routinely mis-buckets credential strings
# (police clearance compliance, ndis worker clearance, cert iv aged care,
# medication endorsement) into domain_knowledge. The downstream score then
# either falsely matches them as Care Skills (when the candidate happens to
# hold the credential and it leaks into the CV text) or counts them as gaps
# (when missing). Neither is what we want — credentials belong on the
# Registration & Licences sidecar, evaluated against user-stored credentials,
# not as keywords.
#
# This pre-match sweep extracts those JD requirements into a separate
# `credentials_required` block so the matched/missed lists — and therefore
# the keyword score — only carry actual skills.
# ---------------------------------------------------------------------------

# Australian unit code prefix alternation — built from the canonical registry
# list (longest-first so longer sub-codes match before their parent codes).
def _build_au_unit_re() -> _re.Pattern:
    from app.services.skills.registry import AU_UNIT_PREFIXES
    alt = "|".join(sorted(AU_UNIT_PREFIXES, key=len, reverse=True))
    return _re.compile(
        r"(?ix)\b("
        # Compliance / clearance / check phrases.
        r"(?:police|national\s+police|ndis(?:\s+worker(?:\s+screening)?)?|"
        r"pre[-\s]?employment\s+medical|criminal\s+history|"
        r"vaccine|vaccination|immuni[sz]ation|infection\s+control|"
        r"working\s+with\s+children|working\s+rights?|work\s+rights?|"
        r"first\s+aid|cpr)\s+"
        r"(?:clearance|check|requirements?|compliance|screening|endorsement)"
        r"|"
        # Australian unit codes — from skills.registry.AU_UNIT_PREFIXES.
        rf"(?:{alt})\d{{3,}}"
        r"|"
        # "Cert III/IV in X" or "X cert III/IV" — qualification names.
        r"cert(?:ificate)?\s*(?:iii|iv|3|4)"
        r"|"
        # Medication endorsement is a credential, not a skill.
        r"medication\s+endorsement(?:\s*\([^)]+\))?"
        r")\b"
    )


_CREDENTIAL_PHRASE_RE = _build_au_unit_re()


def _looks_like_credential(keyword: str) -> bool:
    """True when the phrase matches a credential pattern — should not be
    scored as a skill keyword."""
    return bool(_CREDENTIAL_PHRASE_RE.search(keyword or ""))


def _extract_credential_sidecar(
    matched: Dict[str, Dict[str, List[str]]],
    missed: Dict[str, Dict[str, List[str]]],
) -> Dict[str, Dict[str, List[str]]]:
    """Move credential-shaped keywords OUT of matched/missed and into a sidecar.

    Mutates matched/missed in-place. Returns the sidecar dict with the same
    bucket × category shape, carrying only the moved credential strings so
    the UI can still surface them under a 'Required credentials' section
    without polluting the keyword score.
    """
    sidecar: Dict[str, Dict[str, List[str]]] = {
        b: {c: [] for c in _CATEGORIES} for b in _BUCKETS
    }
    for source, label in ((matched, "matched"), (missed, "missed")):
        for bucket in _BUCKETS:
            for cat in _CATEGORIES:
                kept: List[str] = []
                for kw in source[bucket][cat]:
                    if _looks_like_credential(kw):
                        sidecar[bucket][cat].append(kw)
                    else:
                        kept.append(kw)
                source[bucket][cat] = kept
        del label  # quiet linter
    return sidecar


def _dedup_keep_order(items: List[str]) -> List[str]:
    seen: set[str] = set()
    out: List[str] = []
    for raw in items:
        s = str(raw).strip()
        key = s.lower()
        if s and key not in seen:
            seen.add(key)
            out.append(s)
    return out


def _build_credentials_gap(
    jd_analysis: Dict[str, Any],
    sidecar: Dict[str, Dict[str, List[str]]],
    cv_text: str,
    contact_details: Dict[str, Any] | None,
) -> Dict[str, List[str]]:
    """Build the credential gap report for the matching panel.

    Source of truth is the deterministic ``jd_analysis['credentials']`` block
    (Phase 6/8 scan over the JD text); the regex-extracted ``sidecar`` (pulled
    from LLM-mis-bucketed skills) is merged in as a fallback so nothing is lost.

    Each credential's status is decided WITHOUT an LLM: it is ``present`` when it
    literally appears in the CV text OR is satisfied by the user's profile
    (same ``user_has_credential`` check the feasibility planner uses), otherwise
    it is ``missing``. Required + preferred credentials feed present/missing;
    eligibility is reported but only counted as missing when the profile/CV
    cannot satisfy it.
    """
    block = jd_analysis.get("credentials") or {}
    required = list(block.get("required") or [])
    preferred = list(block.get("preferred") or [])
    eligibility = list(block.get("eligibility") or [])

    # Fallback: fold in any credential-shaped phrases the LLM mis-bucketed as
    # skills (the regex sidecar), so a JD whose deterministic scan missed one
    # still surfaces it. Required-bucket sidecar → required, preferred → preferred.
    for cat in _CATEGORIES:
        required.extend(sidecar.get("required", {}).get(cat, []))
        preferred.extend(sidecar.get("preferred", {}).get(cat, []))

    required = _dedup_keep_order(required)
    preferred = _dedup_keep_order([p for p in preferred if p.lower() not in {r.lower() for r in required}])
    eligibility = _dedup_keep_order(eligibility)

    from app.services.pipeline.steps.keyword_feasibility import user_has_credential

    def _satisfied(phrase: str) -> bool:
        if _literal_match_in_text(phrase, cv_text):
            return True
        if _qualification_subsumed_by_cv(phrase, cv_text):
            return True
        if contact_details and user_has_credential(phrase, contact_details):
            return True
        return False

    present: List[str] = []
    missing: List[str] = []
    for phrase in required + preferred + eligibility:
        (present if _satisfied(phrase) else missing).append(phrase)

    return {
        "required": required,
        "preferred": preferred,
        "eligibility": eligibility,
        "present": _dedup_keep_order(present),
        "missing": _dedup_keep_order(missing),
    }


def _promote_profile_credentials(
    matched: Dict[str, Dict[str, List[str]]],
    missed: Dict[str, Dict[str, List[str]]],
    contact_details: Dict[str, Any],
    user_has_credential_fn,
) -> List[str]:
    """Move missed keywords satisfied by the user's profile from missed → matched.

    Uses the same user_has_credential() check as the feasibility planner so the
    matching panel and the feasibility plan always agree on what's covered.

    Examples: 'national police check', 'work rights', 'influenza vaccination',
    'first aid' — all show as Missing Keywords today because the matcher only
    reads cv_text, not contact_details.

    Mutates matched/missed in-place. Returns the list of promoted keywords.
    """
    promoted: List[str] = []
    for bucket in _BUCKETS:
        for cat in _CATEGORIES:
            still_missed: List[str] = []
            for kw in missed[bucket][cat]:
                if user_has_credential_fn(kw, contact_details):
                    matched[bucket][cat].append(kw)
                    promoted.append(kw)
                else:
                    still_missed.append(kw)
            missed[bucket][cat] = still_missed
    return promoted


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------


def _normalise_match_block(value: Any, *, name: str) -> Dict[str, Dict[str, List[str]]]:
    """Coerce a matched/missed block to the canonical bucket × category shape."""
    if not isinstance(value, dict):
        raise ValueError(
            f"CV-JD matching: '{name}' must be an object with required/preferred"
        )

    out: Dict[str, Dict[str, List[str]]] = {}
    for bucket in _BUCKETS:
        bucket_val = value.get(bucket) or {}
        if not isinstance(bucket_val, dict):
            bucket_val = {}
        out[bucket] = {
            cat: _normalise_keyword_list(bucket_val.get(cat))
            for cat in _CATEGORIES
        }
    return out


def _normalise_keyword_list(items: Any) -> List[str]:
    if not isinstance(items, list):
        return []
    seen: set[str] = set()
    out: List[str] = []
    for raw in items:
        s = str(raw).lower().strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _reconcile_with_jd(
    matching: Dict[str, Any], jd_analysis: Dict[str, Any]
) -> None:
    """
    Make sure every JD keyword is accounted for exactly once.

    For each (bucket, category) in the JD, take the set of input keywords.
    Anything that is not in matched[bucket][category] is forced into
    missed[bucket][category]. Anything the model placed in matched/missed
    that is NOT in the JD's input list is dropped.
    """
    matched = matching["matched"]
    missed = matching["missed"]

    for bucket in _BUCKETS:
        jd_block = jd_analysis.get(f"{bucket}_skills") or {}
        if not isinstance(jd_block, dict):
            jd_block = {}
        for cat in _CATEGORIES:
            jd_keywords = set(_normalise_keyword_list(jd_block.get(cat)))

            # Keep only keywords that came from the JD.
            matched[bucket][cat] = [
                kw for kw in matched[bucket][cat] if kw in jd_keywords
            ]
            in_matched = set(matched[bucket][cat])

            # Anything the AI didn't mark as matched is missed.
            missed[bucket][cat] = sorted(jd_keywords - in_matched)


# ---------------------------------------------------------------------------
# Counts and rates
# ---------------------------------------------------------------------------


def _compute_counts(
    matched: Dict[str, Dict[str, List[str]]], jd_analysis: Dict[str, Any]
) -> Dict[str, Any]:
    counts: Dict[str, Any] = {}
    grand_matched = 0
    grand_total = 0

    for bucket in _BUCKETS:
        jd_block = jd_analysis.get(f"{bucket}_skills") or {}
        if not isinstance(jd_block, dict):
            jd_block = {}
        bucket_counts: Dict[str, Dict[str, int]] = {}
        for cat in _CATEGORIES:
            total = len(_normalise_keyword_list(jd_block.get(cat)))
            m = len(matched[bucket][cat])
            bucket_counts[cat] = {"matched": m, "total": total}
            grand_matched += m
            grand_total += total
        counts[bucket] = bucket_counts

    counts["totals"] = {"matched": grand_matched, "total": grand_total}
    return counts


def _compute_match_rates(counts: Dict[str, Any]) -> Dict[str, float]:
    """Per-category and aggregate match rates as 0–100 floats."""
    def _rate(matched: int, total: int) -> float:
        return round((matched / total) * 100, 1) if total else 0.0

    # Per-category — sum across required + preferred for that category.
    per_cat: Dict[str, Tuple[int, int]] = {c: (0, 0) for c in _CATEGORIES}
    for bucket in _BUCKETS:
        for cat in _CATEGORIES:
            m, t = counts[bucket][cat]["matched"], counts[bucket][cat]["total"]
            pm, pt = per_cat[cat]
            per_cat[cat] = (pm + m, pt + t)

    # Per-bucket — sum across categories within a bucket.
    def _bucket_totals(bucket: str) -> Tuple[int, int]:
        m_sum = sum(counts[bucket][c]["matched"] for c in _CATEGORIES)
        t_sum = sum(counts[bucket][c]["total"] for c in _CATEGORIES)
        return m_sum, t_sum

    req_m, req_t = _bucket_totals("required")
    pref_m, pref_t = _bucket_totals("preferred")
    overall_m = counts["totals"]["matched"]
    overall_t = counts["totals"]["total"]

    return {
        "technical_pct": _rate(*per_cat["technical"]),
        "soft_skills_pct": _rate(*per_cat["soft_skills"]),
        "domain_knowledge_pct": _rate(*per_cat["domain_knowledge"]),
        "required_pct": _rate(req_m, req_t),
        "preferred_pct": _rate(pref_m, pref_t),
        "overall_pct": _rate(overall_m, overall_t),
    }


def _clamp_int(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(100, n))
