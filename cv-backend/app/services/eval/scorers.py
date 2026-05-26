"""
ATS scorer variant registry (Track S).

A scorer is a pure function:  score(cv_text, jd_analysis, matching) -> ats_dict
where ats_dict has at least {"overall_score": int, ...} (the shape returned by
run_ats_scoring). The runner calls the SAME scorer for both the initial CV and
the tailored CV, so initial/final are always comparable.

Phase 1 ships S1 only (the current production scorer). S2 (grounded), S3
(reweighted), S4 (LLM) plug in here later without touching the runner.
"""
from __future__ import annotations

from typing import Any, Callable, Dict

from app.services.pipeline.steps.ats_scoring import run_ats_scoring

# Signature: (cv_text, jd_analysis, matching) -> ats_dict
ScorerFn = Callable[[str, Dict[str, Any], Dict[str, Any]], Dict[str, Any]]


def _scorer_s1_current(
    cv_text: str, jd_analysis: Dict[str, Any], matching: Dict[str, Any]
) -> Dict[str, Any]:
    """Current production deterministic ATS (50 keyword / 35 experience / 15 format)."""
    return run_ats_scoring(cv_text, jd_analysis, matching)


SCORER_VARIANTS: Dict[str, ScorerFn] = {
    "s1_current": _scorer_s1_current,
}


def get_scorer(scorer_variant: str) -> ScorerFn:
    fn = SCORER_VARIANTS.get(scorer_variant)
    if fn is None:
        raise ValueError(
            f"Unknown scorer_variant '{scorer_variant}'. "
            f"Known: {sorted(SCORER_VARIANTS)}"
        )
    return fn
