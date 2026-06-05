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
# Profile credential promotion
# ---------------------------------------------------------------------------


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
