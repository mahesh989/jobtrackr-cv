"""Step 6 — Tailored CV generation.

Calls AI to rewrite the CV in markdown, then uploads the markdown to
Supabase Storage and returns the storage path.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_cv._common import logger  # noqa: F401
from app.services.pipeline.steps.tailored_cv.text import (  # noqa: F401
    _DANGLING_WORDS,
    _strip_trailing_danglers,
    _trim_to_words,
)
from app.services.pipeline.steps.tailored_cv.summary import (  # noqa: F401
    _FORBIDDEN_OPENER_RE,
    _GENERIC_CARE_PHRASES,
    _GENERIC_CARE_RE,
    _SENIORITY_PREFIX_RE,
    _SUMMARY_HEADING_RE,
    _TITLE_CASE_STOP,
    _VAGUE_ANCHOR_RE,
    _clean_job_title,
    _enforce_summary_opener,
    _enforce_summary_s1_title_case,
    _enforce_summary_s2_word_cap,
    _find_summary_block,
    _flag_vague_anchor,
    _get_summary_prose,
    _lowercase_generic_care_phrases,
    _norm_opener_title,
    _title_case_role,
)
from app.services.pipeline.steps.tailored_cv.employers import (  # noqa: F401
    _DANGLING_END_RE,
    _EXP_ENTRY_RE,
    _EXP_SECTION_RE,
    _enforce_company_anchor,
    _extract_employers_from_cv,
)
from app.services.pipeline.steps.tailored_cv.projects import (  # noqa: F401
    _dedup_project_bullets,
    _norm_bullet,
)
from app.services.pipeline.steps.tailored_cv.credentials import (  # noqa: F401
    _QUAL_CERT_RE,
    _cert_policy_for,
    _enforce_education_count,
    _norm_credential,
    _promote_qualification_cert_to_education,
    _split_cert_entry,
    _strip_certs_when_excluded,
    _strip_certs_when_projects_exist,
    _strip_education_bullets,
)
from app.services.pipeline.steps.tailored_cv.skills_injection import (  # noqa: F401
    _SKILLS_CATEGORY_LABEL,
    _format_skill_label,
    _inject_missing_skills,
    _kw_in_skills,
    build_family_label_map,
)
from app.services.pipeline.steps.tailored_cv.structure import (  # noqa: F401
    _dedup_career_highlights,
    _enforce_bullets,
    _enforce_career_highlights_words,
    _enforce_other_skills_chars,
    _enforce_section_roles,
    _enforce_structure,
)
from app.services.pipeline.steps.tailored_cv.runner import (  # noqa: F401
    _upload_to_storage,
    run_tailored_cv,
)

__all__ = [
    "build_family_label_map",
    "run_tailored_cv",
]
