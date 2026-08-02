"""Step 6.6 — Deterministic structural validation of the tailored CV.

After the AI writer has produced the tailored markdown, we run a series of
pure-function "gates" over the document. Each gate checks one structural
rule from the STRUCTURAL CONTRACT in TAILORED_CV_SYSTEM. The output is a
report — never a rewrite. The pipeline never fails on a structural gate;
gates only emit pass / warn / fail labels for the user to inspect.

Why deterministic and not another AI call?
  - The shape of the output is independent of any model judgement; we can
    parse it directly.
  - It produces a stable, reproducible signal we can show the user when
    the writer drifted from the contract.
  - It costs nothing (no tokens) and adds milliseconds, not seconds.

The gates are intentionally narrow — each one tests exactly ONE rule, so
the report is easy to interpret. They never overlap with the rescoring
step's keyword-presence checks (`tailored_rescoring.py`) or with the
fabrication detector (`fabricated_keywords`).

Output shape:
    {
      "gates": [
        {"name": str, "status": "pass" | "warn" | "fail", "detail": str}
      ],
      "summary": {"total": int, "pass": int, "warn": int, "fail": int}
    }

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation._common import logger  # noqa: F401
from app.services.pipeline.steps.tailored_structural_validation.results import (  # noqa: F401
    _result,
    _short,
)
from app.services.pipeline.steps.tailored_structural_validation.parsing import (  # noqa: F401
    _EDUCATION_ALIASES,
    _ENTRY_TITLE_RE,
    _EXPERIENCE_ALIASES,
    _ITALIC_SUBLINE_RE,
    _PROFILE_ALIASES,
    _PROJECTS_ALIASES,
    _SKILLS_ALIASES,
    _check_two_line_shape,
    _parse_entries,
    _parse_two_line_blocks,
    _resolve_section,
    _split_sections,
    _word_count,
)
from app.services.pipeline.steps.tailored_structural_validation.relevance import (  # noqa: F401
    _RELEVANCE_PREFIX_LEN,
    _RELEVANCE_STOPWORDS,
    _build_jd_vocabulary,
    _has_overlap,
    _normalise_token,
    _tokenise_for_relevance,
)
from app.services.pipeline.steps.tailored_structural_validation.gates_prose import (  # noqa: F401
    _SENIORITY_TOKENS,
    _gate_highlights_no_bullets,
    _gate_highlights_prose_shape,
    _gate_highlights_reference_check,
    _gate_profile_word_count,
    _gate_seniority_literal_match,
)
from app.services.pipeline.steps.tailored_structural_validation.gates_experience import (  # noqa: F401
    _METRIC_PATTERN,
    _gate_bullets_per_entry,
    _gate_experience_bullet_length,
    _gate_experience_role_count,
    _gate_metric_coverage,
    _gate_period_terminator,
)
from app.services.pipeline.steps.tailored_structural_validation.gates_sections import (  # noqa: F401
    _gate_degree_relevance,
    _gate_education_count,
    _gate_education_entry_shape,
    _gate_project_entry_shape,
    _gate_project_relevance,
    _gate_projects_count,
    _gate_skills_min_per_category,
    _resolve_expected_skills_labels,
)
from app.services.pipeline.steps.tailored_structural_validation.runner import (  # noqa: F401
    run_tailored_structural_validation,
)

__all__ = [
    "run_tailored_structural_validation",
]
