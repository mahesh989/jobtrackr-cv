"""
Step 4 — Input Recommendations.

Deterministic, no AI call. Reads the structured matching/ATS output from
Steps 2-3 and produces a categorised payload the downstream AI steps
(feasibility classifier, AI recommendations, tailored CV) will consume.

Output schema:

    {
      "missing_keywords": {
        "required":  {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]},
        "preferred": {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]},
        "all":       [str, ...]                # flat, sorted, dedup
      },
      "matched_keywords": {
        "required":  {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]},
        "preferred": {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}
      },
      "weak_sections": [{"section": str, "reason": str}, ...],
      "suggested_additions": {
        "technical_to_add":         [...],     # required-bucket technical misses, top N
        "soft_skills_to_emphasise": [...],     # required-bucket soft misses, top N
        "domain_terms_to_emphasise":[...],     # required-bucket domain misses, top N
        "preferred_to_consider":    [...]      # preferred-bucket misses, mixed
      },
      "stats": {
        "n_missing_required":  int,
        "n_missing_preferred": int,
        "n_matched_required":  int,
        "n_matched_preferred": int,
        "ats_overall":         int,
        "keyword_match_pct":   float
      }
    }
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

from app.enums import BUCKET_KEYS as _BUCKETS, CATEGORY_KEYS as _CATEGORIES

# How many candidates to surface per "suggested addition" group.
_SUGGEST_LIMIT_TECHNICAL = 10
_SUGGEST_LIMIT_SOFT = 6
_SUGGEST_LIMIT_DOMAIN = 6
_SUGGEST_LIMIT_PREFERRED = 8


def run_input_recommendations(
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    ats_scores: Dict[str, Any],
) -> Dict[str, Any]:
    missing = _categorised(matching.get("missed"))
    matched = _categorised(matching.get("matched"))

    flat_missing = sorted({
        kw
        for bucket in _BUCKETS
        for cat in _CATEGORIES
        for kw in missing[bucket][cat]
    })

    suggested = _suggested_additions(missing)
    weak = _weak_sections(ats_scores)
    stats = _stats(missing, matched, ats_scores, matching)

    return {
        "missing_keywords": {
            "required":  missing["required"],
            "preferred": missing["preferred"],
            "all":       flat_missing,
        },
        "matched_keywords": {
            "required":  matched["required"],
            "preferred": matched["preferred"],
        },
        "weak_sections": weak,
        "suggested_additions": suggested,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _categorised(value: Any) -> Dict[str, Dict[str, List[str]]]:
    """Coerce a matched/missed block (from Step 2) to the canonical shape.

    Tolerates partial/missing structures so downstream code never KeyErrors.
    """
    out: Dict[str, Dict[str, List[str]]] = {
        b: {c: [] for c in _CATEGORIES} for b in _BUCKETS
    }
    if not isinstance(value, dict):
        return out

    for bucket in _BUCKETS:
        bucket_val = value.get(bucket) or {}
        if not isinstance(bucket_val, dict):
            continue
        for cat in _CATEGORIES:
            items = bucket_val.get(cat) or []
            if not isinstance(items, list):
                continue
            seen: set[str] = set()
            cleaned: List[str] = []
            for raw in items:
                s = str(raw).lower().strip()
                if s and s not in seen:
                    seen.add(s)
                    cleaned.append(s)
            out[bucket][cat] = cleaned
    return out


def _suggested_additions(
    missing: Dict[str, Dict[str, List[str]]],
) -> Dict[str, List[str]]:
    """
    Build the "what to consider injecting" lists.

    These are deterministic candidate pools — Sprint 2's feasibility
    classifier will decide which of these can ACTUALLY be injected based
    on CV evidence. We never claim something will be added; we just
    surface the JD-side opportunity space.
    """
    req = missing["required"]
    pref = missing["preferred"]

    # Mix preferred buckets into a single rotation so the AI sees a balanced
    # slice rather than (e.g.) only preferred-technical.
    preferred_mixed: List[str] = []
    for cat in _CATEGORIES:
        preferred_mixed.extend(pref[cat])
    # Stable order: by insertion (matches AI/JD order) then alphabetical
    # for ties — caller can re-rank by feasibility later.
    preferred_mixed = list(dict.fromkeys(preferred_mixed))

    return {
        "technical_to_add":          req["technical"][:_SUGGEST_LIMIT_TECHNICAL],
        "soft_skills_to_emphasise":  req["soft_skills"][:_SUGGEST_LIMIT_SOFT],
        "domain_terms_to_emphasise": req["domain_knowledge"][:_SUGGEST_LIMIT_DOMAIN],
        "preferred_to_consider":     preferred_mixed[:_SUGGEST_LIMIT_PREFERRED],
    }


def _weak_sections(ats_scores: Dict[str, Any]) -> List[Dict[str, str]]:
    weak: List[Dict[str, str]] = []

    if _safe_int(ats_scores.get("keyword_match_score")) < 60:
        weak.append({
            "section": "skills",
            "reason": (
                "Keyword coverage is below 60% — surface more JD-relevant "
                "skills in the skills section and bullets."
            ),
        })

    if _safe_int(ats_scores.get("experience_match_score")) < 60:
        weak.append({
            "section": "experience",
            "reason": (
                "Experience alignment is weak — rewrite bullets to use JD "
                "terminology and quantify impact."
            ),
        })

    if _safe_int(ats_scores.get("formatting_score")) < 70:
        weak.append({
            "section": "formatting",
            "reason": (
                "CV is missing standard sections, contact info, or has an "
                "unusual length — restructure for ATS readability."
            ),
        })

    return weak


def _stats(
    missing: Dict[str, Dict[str, List[str]]],
    matched: Dict[str, Dict[str, List[str]]],
    ats_scores: Dict[str, Any],
    matching: Dict[str, Any],
) -> Dict[str, Any]:
    def _count(block: Dict[str, Dict[str, List[str]]], bucket: str) -> int:
        return sum(len(block[bucket][c]) for c in _CATEGORIES)

    rates = matching.get("match_rates") or {}

    return {
        "n_missing_required":  _count(missing, "required"),
        "n_missing_preferred": _count(missing, "preferred"),
        "n_matched_required":  _count(matched, "required"),
        "n_matched_preferred": _count(matched, "preferred"),
        "ats_overall":         _safe_int(ats_scores.get("overall_score")),
        "keyword_match_pct":   float(rates.get("overall_pct") or 0.0),
    }


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
