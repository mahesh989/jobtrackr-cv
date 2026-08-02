"""Step entry point — runs every gate and assembles the result.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
from ._common import logger
from .gates_experience import (
    _gate_bullets_per_entry,
    _gate_experience_bullet_length,
    _gate_experience_role_count,
    _gate_metric_coverage,
    _gate_period_terminator,
)
from .gates_prose import (
    _gate_highlights_no_bullets,
    _gate_highlights_prose_shape,
    _gate_highlights_reference_check,
    _gate_profile_word_count,
    _gate_seniority_literal_match,
)
from .gates_sections import (
    _gate_degree_relevance,
    _gate_education_count,
    _gate_education_entry_shape,
    _gate_project_entry_shape,
    _gate_project_relevance,
    _gate_projects_count,
    _gate_skills_min_per_category,
    _resolve_expected_skills_labels,
)
from .parsing import _split_sections
from .relevance import _build_jd_vocabulary

def run_tailored_structural_validation(
    tailored_markdown: str,
    original_cv_text: str = "",
    jd_analysis: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """
    Top-level entry point. Returns a structural report dict — never raises.

    `jd_analysis` is the step-1 JD analysis output; passing it enables the
    relevance-gates (degree relevance, project relevance) which need a JD
    vocabulary to score against. Omitting it makes those gates skip with
    a "pass" status (graceful degradation).
    """
    try:
        sections = _split_sections(tailored_markdown or "")
        jd_vocab = _build_jd_vocabulary(jd_analysis or {})

        # Family-aware expected Skills categories. The first label varies by
        # role family ("Technical Skills" for tech, "Care Skills" for nursing,
        # "Core Skills" for manual). The gate fails harmlessly for tech CVs if
        # we omit this — its hardcoded {Technical, Soft, Other} was never going
        # to pass nursing or manual CVs.
        expected_skills_labels = _resolve_expected_skills_labels(jd_analysis)

        gates: List[Dict[str, Any]] = [
            _gate_profile_word_count(sections),
            _gate_seniority_literal_match(sections, original_cv_text),
            _gate_experience_role_count(sections),
            _gate_education_count(sections),
            _gate_projects_count(sections),
            _gate_bullets_per_entry(sections),
            _gate_highlights_no_bullets(sections),
            _gate_experience_bullet_length(sections),
            _gate_period_terminator(sections),
            _gate_metric_coverage(sections),
            _gate_skills_min_per_category(sections, expected_skills_labels),
            _gate_highlights_prose_shape(sections),
            _gate_highlights_reference_check(sections),
            _gate_degree_relevance(sections, jd_vocab),
            _gate_project_relevance(sections, jd_vocab),
            _gate_education_entry_shape(sections),
            _gate_project_entry_shape(sections),
        ]

        summary = {
            "total": len(gates),
            "pass":  sum(1 for g in gates if g["status"] == "pass"),
            "warn":  sum(1 for g in gates if g["status"] == "warn"),
            "fail":  sum(1 for g in gates if g["status"] == "fail"),
        }
        return {"gates": gates, "summary": summary}
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("Structural validation crashed: %s", exc)
        return {
            "gates": [],
            "summary": {"total": 0, "pass": 0, "warn": 0, "fail": 0},
            "error": f"validator_crashed: {exc}",
        }
