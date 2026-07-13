"""Single source of truth for ATS keyword weights and pipeline constants.

Import from here — never redefine in ats_scoring.py, keyword_feasibility.py,
cv_jd_matching.py, or input_recommendations.py.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Canonical bucket and category tuples — used across pipeline steps.
BUCKETS   = ("required", "preferred")
CATEGORIES = ("technical", "soft_skills", "domain_knowledge")

# Per-component max points (Category 1 totals 50 pts).
DEFAULT_KEYWORD_WEIGHTS: dict[str, int] = {
    "technical_required":        25,
    "soft_skills_required":      10,
    "domain_knowledge_required":  5,
    "preferred_overall":         10,
}


def resolve_keyword_weights(jd_analysis: dict[str, Any] | None) -> dict[str, int]:
    """Return per-family keyword weights, falling back to DEFAULT_KEYWORD_WEIGHTS.

    The orchestrator stores the resolved role family on jd_analysis["role_family"].
    Nursing/manual flip technical ↔ domain because headline competencies live in
    domain_knowledge for those families. Unknown/master families use tech defaults.
    """
    family_id = (jd_analysis or {}).get("role_family")
    if family_id:
        try:
            from app.services.eval.role_families import resolve_role_family
            rf = resolve_role_family(family_id, jd_analysis)
            if rf and rf.keyword_weights:
                return dict(rf.keyword_weights)
        except Exception:  # noqa: BLE001
            logger.warning("resolve_keyword_weights: failed for family %s; using defaults", family_id)
    return dict(DEFAULT_KEYWORD_WEIGHTS)
