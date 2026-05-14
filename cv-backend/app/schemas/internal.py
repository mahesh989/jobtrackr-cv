"""Request/response schemas for the JobTrackr ↔ cv-backend internal API."""
from __future__ import annotations

import uuid
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field, HttpUrl


# ── /internal/analyze ─────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    """
    Triggers a pipeline run. JobTrackr pre-creates the analysis_runs row
    (status='pending') and passes the id here; cv-backend writes step results
    back to that row via Supabase service-role.
    """
    run_id:         uuid.UUID
    user_id:        uuid.UUID
    cv_version_id:  uuid.UUID

    # JD already resolved by JobTrackr (full text or scraped). cv-backend does
    # not re-scrape unless explicitly asked via /internal/scrape-jd.
    jd_text:        str = Field(min_length=1)
    jd_source_url:  Optional[str] = None
    jd_meta:        Optional[Dict[str, Any]] = None     # title, source, company…

    # Pre-extracted CV text (JobTrackr handles pypdf at upload time).
    cv_text:        str = Field(min_length=1)

    # BYOK — per-request key, never persisted in cv-backend.
    ai_provider:    Literal["anthropic", "openai", "deepseek"]
    ai_api_key:     str = Field(min_length=1)
    # Optional model override (e.g. "claude-sonnet-4-6", "gpt-4o"). When null
    # cv-backend falls back to _DEFAULT_MODELS[provider].
    ai_model:       Optional[str] = None


class AnalyzeResponse(BaseModel):
    run_id: uuid.UUID
    status: Literal["accepted"] = "accepted"


# ── /internal/extract-cv-text ────────────────────────────────────────────────

class ExtractCvTextRequest(BaseModel):
    """Fetch a PDF from Supabase Storage and return its plain-text extraction."""
    storage_path: str = Field(min_length=1)            # e.g. "cvs/<user_id>/<cv_id>.pdf"


class ExtractCvTextResponse(BaseModel):
    cv_text:    str
    word_count: int


# ── /internal/scrape-jd ──────────────────────────────────────────────────────

class ScrapeJdRequest(BaseModel):
    """Scrape a job-posting URL for plain JD text + best-effort title."""
    url: HttpUrl


class ScrapeJdResponse(BaseModel):
    jd_text:    str
    job_title:  Optional[str] = None
    source_url: str


# ── /internal/categorise-cv ──────────────────────────────────────────────────

class CategoriseCvRequest(BaseModel):
    """
    Categorise the skills in a CV. BYOK — JobTrackr passes the user's AI
    credentials per-request, cv-backend never persists them.
    """
    cv_text:     str = Field(min_length=1)
    ai_provider: Literal["anthropic", "openai", "deepseek"]
    ai_api_key:  str = Field(min_length=1)
    ai_model:    Optional[str] = None


class CategoriseCvResponse(BaseModel):
    technical:        list[str]
    soft_skills:      list[str]
    domain_knowledge: list[str]
