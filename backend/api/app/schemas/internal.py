"""Request/response schemas for the JobTrackr ↔ cv-backend internal API."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, HttpUrl

from app.enums import Provider
from app.schemas._byok import BYOK
from app.schemas.stories import ExtractStoriesResponse  # noqa: F401 — re-exported
from app.schemas.voice import VoiceFingerprint


# ── /internal/analyze ─────────────────────────────────────────────────────────

class AnalyzeRequest(BYOK):
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

    # Optional contact details (name, phone, email, urls, projects). When
    # present, stamp_contact_line() overwrites the contact line under the H1
    # on the tailored CV markdown so the output always shows the user's
    # canonical contact info.
    contact_details: Optional[Dict[str, Any]] = None

    # Pipeline-automation gate thresholds. Globally fixed by migration 041
    # (was per-profile). Web and worker no longer send these in the payload —
    # the defaults below ARE the rule. Kept as optional fields for backward
    # compat with any caller that still sends them.
    #
    # Initial-gate value lowered 60 → 50 alongside ATS scoring v2
    # (backend/api/docs/ATS_SCORING_V2.md): v1 awarded an 8-pt role-family
    # "freebie" and double-counted required-keyword match-rate in Cat 2,
    # which inflated borderline CVs into the 60s. v2 removes both, so an
    # honest moderate-fit CV that v1 scored 62 (with 8 freebie + ~7
    # double-count) now lands near 50. Leaving the gate at 60 would
    # silently lock those users out with no clear reason. 50 keeps the
    # early-stop on genuinely-weak CVs (irrelevant SWE-vs-nursing now
    # ≤25) while letting honest moderate-fit cases through.
    min_initial_ats: float = 50
    # Final-gate is the trigger for auto cover-letter generation. Same v2
    # inflation logic applies — left at 70 for now (auto cover-letter
    # firing on FEWER, more-honest tailored CVs is arguably correct), but
    # if real users start losing auto cover-letters that previously fired,
    # consider 70 → 60 to match the initial-gate shift.
    min_final_ats:   float = 70

    # Phase C-3 — override flag. When False (default), the orchestrator
    # STOPS before tailoring if the initial ATS score is below
    # min_initial_ats (saves ~3 AI calls per low-match job). When True
    # (sent by the web layer when the user clicks "Force tailoring"),
    # the pipeline runs to completion regardless of the gate. The
    # gate result is always recorded — only the early-stop is gated.
    skip_initial_gate: bool = False

    # Resume marker. True ONLY when the web layer re-triggers an existing
    # run that previously stopped at the initial-ATS gate (user clicked
    # "Tailor CV anyway"). The orchestrator reuses the already-saved
    # jd_analysis / cv_jd_matching / ats_scoring results on that run row
    # and continues from input_recommendations onward — saving the two AI
    # calls those early steps would otherwise repeat. Implies the initial
    # gate is bypassed regardless of skip_initial_gate.
    resume: bool = False

    # Phase E-1 — automation marker. True ONLY when the run was triggered
    # by the worker's auto-analyze step (scheduled pipeline). The web
    # /api/jobs/[id]/analyze route always sends False so manual runs stay
    # distinguishable in analytics. Stored on the analysis_runs row.
    automation: bool = False

    # Explicit vertical from the user's job search profile ("tech", "nursing",
    # "manual", "general"). When present the orchestrator skips alias-based
    # auto-detection and routes directly to this vertical. None = auto-detect
    # (legacy behaviour for callers that haven't been updated yet).
    target_vertical: Optional[str] = None


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

class CategoriseCvRequest(BYOK):
    """
    Categorise the skills in a CV. BYOK — JobTrackr passes the user's AI
    credentials per-request, cv-backend never persists them.
    """
    cv_text: str = Field(min_length=1)


class CategoriseCvResponse(BaseModel):
    technical:        list[str]
    soft_skills:      list[str]
    domain_knowledge: list[str]


# ── /internal/extract-cv-references ──────────────────────────────────────────

class ExtractCvReferencesRequest(BYOK):
    """Extract referee details from a CV (BYOK)."""
    cv_text: str = Field(min_length=1)


class CvReferee(BaseModel):
    name:      str = ""
    job_title: str = ""
    company:   str = ""
    email:     str = ""


class ExtractCvReferencesResponse(BaseModel):
    referees: list[CvReferee]


# ── /internal/structurize-cv ─────────────────────────────────────────────────

class StructurizeCvRequest(BYOK):
    """Parse a CV into the normalised structured-CV object (BYOK).

    Single AI call — returns contact, summary, experience, education,
    certifications, skills (categorised), and references in one response.
    """
    cv_text: str = Field(min_length=1)


class StructurizeCvResponse(BaseModel):
    # The full structured CV object — shape defined in
    # app/services/cv/cv_structurizer.py. Kept as a free dict so the schema
    # can evolve without a migration on this transport type.
    structured_cv:      dict
    normalized_cv_text: str


class RenderCanonicalCvRequest(BaseModel):
    """Re-render a structured CV into canonical markdown text. Pure +
    deterministic (no AI call) — used by the autosave path so the web layer
    doesn't carry its own copy of the renderer."""
    structured_cv: dict


class RenderCanonicalCvResponse(BaseModel):
    normalized_cv_text: str


# ── /internal/extract-voice-fingerprint ──────────────────────────────────────

class ExtractVoiceFingerprintRequest(BYOK):
    """
    Extract a voice fingerprint from a writing sample. BYOK — key never
    persisted in cv-backend. voice_sample_text must not appear in logs.
    """
    voice_sample_text: str = Field(min_length=1)


class ExtractVoiceFingerprintResponse(BaseModel):
    fingerprint:        VoiceFingerprint
    trust_score:        float
    trust_components:   Dict[str, float]   # ai_pattern, sentence_variance, length
    word_count:         int
    matched_ai_phrases: list[str]


# ── /internal/extract-stories ─────────────────────────────────────────────────

class ExtractStoriesRequest(BYOK):
    """
    Extract structured achievement stories from a master CV.
    BYOK — key never persisted in cv-backend.
    cv_text must not appear in logs (privacy boundary — see story_extractor.py).
    """
    user_id: uuid.UUID
    cv_text: str = Field(min_length=1)


# ── /internal/classify-skills ─────────────────────────────────────────────────

class ClassifySkillsRequest(BaseModel):
    items:    List[str] = Field(min_length=1)
    vertical: Optional[str] = None  # "nursing" | "tech" | "cleaning" | None


class ClassifiedSkillItem(BaseModel):
    item:         str
    category:     Optional[str]  # domain_knowledge | soft_skills | technical | None
    canonical:    Optional[str]
    is_noise:     bool
    action:       str  # correct | correct_technical | should_be_care_skills | should_be_stripped | add_to_lexicon


class ClassifySkillsResponse(BaseModel):
    results: List[ClassifiedSkillItem]
