"""
Prompt templates for each pipeline step — re-exported for backward compatibility.

Each prompt is split into a `system` (role / output contract) and a
`user_template` (data to analyse) so callers can substitute inputs.

Internal layout:
  jd_analysis.py             — Step 1: JD Analysis
  cv_jd_matching.py          — Step 2: CV-JD Matching
  keyword_feasibility.py     — Step 4.5: Keyword Feasibility Classifier
  ai_recommendations.py      — Step 5: AI Recommendations (markdown advice)
  tailored_cv.py             — Step 6: Tailored CV Generation
  cv_skill_categorisation.py — CV Skill Categorisation (one-time, at CV upload)
"""
from __future__ import annotations

from .jd_analysis import (
    JD_ANALYSIS_SYSTEM,
    JD_ANALYSIS_USER_TEMPLATE,
    JD_ANALYSIS_VALIDATOR_SYSTEM,
    JD_ANALYSIS_VALIDATOR_USER_TEMPLATE,
    build_jd_analysis_system_prompt,
    build_jd_analysis_validator_prompt,
)
from .cv_jd_matching import CV_JD_MATCHING_SYSTEM, CV_JD_MATCHING_USER_TEMPLATE
from .keyword_feasibility import (
    KEYWORD_FEASIBILITY_SYSTEM,
    KEYWORD_FEASIBILITY_USER_TEMPLATE,
)
from .ai_recommendations import (
    AI_RECOMMENDATIONS_SYSTEM,
    AI_RECOMMENDATIONS_USER_TEMPLATE,
)
from .tailored_cv import TAILORED_CV_SYSTEM, TAILORED_CV_USER_TEMPLATE
from .cv_skill_categorisation import (
    CV_SKILL_CATEGORISATION_SYSTEM,
    CV_SKILL_CATEGORISATION_USER_TEMPLATE,
)
from .cv_references_extraction import (
    CV_REFERENCES_EXTRACTION_SYSTEM,
    CV_REFERENCES_EXTRACTION_USER_TEMPLATE,
)
from .cv_structurization import (
    CV_STRUCTURIZATION_SYSTEM,
    CV_STRUCTURIZATION_USER_TEMPLATE,
)
from .cover_letter.voice_fingerprint import (
    VOICE_FINGERPRINT_SYSTEM,
    VOICE_FINGERPRINT_USER_TEMPLATE,
)
from .cover_letter.story_extraction import (
    STORY_EXTRACTION_SYSTEM,
    STORY_EXTRACTION_USER_TEMPLATE,
)
from .cover_letter.opening_variants import (
    VARIANTS_SYSTEM,
    VARIANTS_USER_TEMPLATE,
)

__all__ = [
    "JD_ANALYSIS_SYSTEM",
    "JD_ANALYSIS_USER_TEMPLATE",
    "JD_ANALYSIS_VALIDATOR_SYSTEM",
    "JD_ANALYSIS_VALIDATOR_USER_TEMPLATE",
    "build_jd_analysis_system_prompt",
    "build_jd_analysis_validator_prompt",
    "CV_JD_MATCHING_SYSTEM",
    "CV_JD_MATCHING_USER_TEMPLATE",
    "KEYWORD_FEASIBILITY_SYSTEM",
    "KEYWORD_FEASIBILITY_USER_TEMPLATE",
    "AI_RECOMMENDATIONS_SYSTEM",
    "AI_RECOMMENDATIONS_USER_TEMPLATE",
    "TAILORED_CV_SYSTEM",
    "TAILORED_CV_USER_TEMPLATE",
    "CV_SKILL_CATEGORISATION_SYSTEM",
    "CV_SKILL_CATEGORISATION_USER_TEMPLATE",
    "CV_REFERENCES_EXTRACTION_SYSTEM",
    "CV_REFERENCES_EXTRACTION_USER_TEMPLATE",
    "CV_STRUCTURIZATION_SYSTEM",
    "CV_STRUCTURIZATION_USER_TEMPLATE",
    "VOICE_FINGERPRINT_SYSTEM",
    "VOICE_FINGERPRINT_USER_TEMPLATE",
    "STORY_EXTRACTION_SYSTEM",
    "STORY_EXTRACTION_USER_TEMPLATE",
    "VARIANTS_SYSTEM",
    "VARIANTS_USER_TEMPLATE",
]
