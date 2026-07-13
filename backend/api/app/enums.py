"""
Shared enums — single source of truth for string constants used across modules.

StrEnum so values are plain strings at runtime (no .value needed), compatible
with Supabase REST payloads, Pydantic Literal fields, and dict keys.
"""
from __future__ import annotations

from enum import StrEnum


class Provider(StrEnum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    DEEPSEEK = "deepseek"


class SkillCategory(StrEnum):
    TECHNICAL = "technical"
    SOFT_SKILLS = "soft_skills"
    DOMAIN_KNOWLEDGE = "domain_knowledge"


class StepName(StrEnum):
    JD_ANALYSIS = "jd_analysis"
    CV_JD_MATCHING = "cv_jd_matching"
    ATS_SCORING = "ats_scoring"
    INPUT_RECOMMENDATIONS = "input_recommendations"
    KEYWORD_FEASIBILITY = "keyword_feasibility"
    AI_RECOMMENDATIONS = "ai_recommendations"
    TAILORED_CV = "tailored_cv"


class StepState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class RunStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class CoverLetterStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    PICKING = "picking"


class CompanyResearchStatus(StrEnum):
    COMPLETED = "completed"
    CACHED = "cached"
    RUNNING = "running"
