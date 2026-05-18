"""Pydantic schemas for company research — Phase 10.3.

Import path: app.schemas.company

Design notes:
- company_id is a text slug ('jll_australia'), not a UUID. Computed by
  services/company/slug.py from the company name. Matches the DB primary key.
- CompanyResearch is the top-level object written to / read from the
  company_research table (global, shared across all users).
- RecentEvent.stale is set by researcher.py, never by the AI model.
  The model is not asked to compute staleness; the service injects it
  after comparing the event date to now() - 12 months.
- VoiceSignals.tone uses Literal to catch model hallucination of
  non-spec values at the Pydantic layer.
- hiring_intel fields are Optional/empty-list defaults — LinkedIn
  scraping is blocked in Phase 10.3; these are best-effort fields.
- research_quality_score is computed by quality_scorer.py before
  writing. Range [0.0, 1.0].
- ResearchCompanyRequest carries the triggering user's BYOK AI key
  (provider + api_key + optional model). The key is never stored in
  cv-backend — used only for the distillation model call in researcher.py.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ── Sub-objects returned by the AI distillation call ─────────────────────────

class RecentEvent(BaseModel):
    date: Optional[str] = None          # ISO date string as returned by model; may be absent
    event: str
    source_url: Optional[str] = None
    relevance_to_applicants: str
    stale: bool = False                 # injected by researcher.py; not from the model


class CompanyFacts(BaseModel):
    description_short: str
    industry: str
    size: Literal["startup", "small", "mid", "large", "enterprise"]
    headquarters: str
    recent_events: list[RecentEvent] = Field(default_factory=list)
    products_or_services: list[str] = Field(default_factory=list)
    mission_statement: str = ""
    distinguishing_facts: list[str] = Field(default_factory=list)


class VoiceSignals(BaseModel):
    tone: Literal[
        "formal_corporate",
        "professional_warm",
        "casual_startup",
        "technical",
        "mission_driven",
    ]
    sample_text: str = ""
    common_vocabulary: list[str] = Field(default_factory=list)
    avoids: list[str] = Field(default_factory=list)


class HiringIntel(BaseModel):
    hiring_manager_likely: Optional[str] = None
    team_blog_posts: list[str] = Field(default_factory=list)
    recent_hires_titles: list[str] = Field(default_factory=list)


# ── Top-level company research record ─────────────────────────────────────────

class CompanyResearch(BaseModel):
    company_id: str
    name: str
    domain: Optional[str] = None
    last_researched_at: datetime
    research_ttl_days: int = 90
    facts: CompanyFacts
    voice_signals: VoiceSignals
    hiring_intel: HiringIntel
    research_quality_score: float = Field(ge=0.0, le=1.0, default=0.0)
    search_skipped: bool = False


# ── Internal endpoint request / response ──────────────────────────────────────

class ResearchCompanyRequest(BaseModel):
    company_name: str
    company_domain: Optional[str] = None
    ai_provider: Literal["anthropic", "openai", "deepseek"]
    ai_api_key: str
    ai_model: Optional[str] = None


class ResearchCompanyResponse(BaseModel):
    company_id: str
    status: Literal["completed", "cached", "running"]
    research: Optional[CompanyResearch] = None
    search_skipped: bool = False


class RankedFact(BaseModel):
    fact_text: str
    score: float
    source_field: str           # e.g. 'distinguishing_facts[0]', 'mission_statement'


class SelectCompanyFactRequest(BaseModel):
    company_id: str
    facts: CompanyFacts
    jd_text: str
    cv_text: str


class SelectCompanyFactResponse(BaseModel):
    ranked_facts: list[RankedFact]
