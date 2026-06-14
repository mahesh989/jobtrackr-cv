"""Lexicon-based skill classification.

See `lexicons/README.md` for the data model. Public API:

    from app.services.skills import classify, is_noise, Classification

`classify(phrase, vertical)` resolves a raw skill phrase to a canonical
taxonomy entry. The category is decided by the LEXICON, never by an LLM —
the same lexicon classifies both CV and JD, so a skill lands in the same
bucket on both sides. Unknown phrases return None (safe-drop, log
upstream) instead of being guessed into a wrong bucket.
"""
from app.services.skills.classifier import (
    Classification,
    classify,
    classify_many,
    is_noise,
    lexicon_stats,
    normalise,
)
from app.services.skills.post_process import (
    clamp_by_jd_sections,
    enrich_required_skills_from_jd_body,
    post_process_cv_skills,
    post_process_jd_analysis,
    post_process_skills,
    verify_skill_evidence,
)

__all__ = [
    "Classification",
    "clamp_by_jd_sections",
    "classify",
    "classify_many",
    "enrich_required_skills_from_jd_body",
    "is_noise",
    "lexicon_stats",
    "normalise",
    "post_process_cv_skills",
    "post_process_jd_analysis",
    "post_process_skills",
    "verify_skill_evidence",
]
