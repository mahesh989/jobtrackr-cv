"""Pydantic schemas for cover letter generation — Phase 10.4.

Import path: app.schemas.cover_letter

Design notes:
- GenerateCoverLetterRequest carries all inputs needed for cover letter
  generation. cv-backend does NOT look up story or voice data from Supabase —
  the web route resolves and decrypts all inputs before calling cv-backend.
  This matches the pattern of /internal/analyze.

- ai_model is the user's chosen model from their integration settings. The
  generator uses it for the single generation call and the honesty gate.
  Falls back to a provider-specific default if None.

- fingerprint, tone_target, and word_count_target are accepted for API
  stability but no longer drive generation. The single-call architecture
  uses voice_sample_text as the register anchor and hard-codes a 250-400
  word target in the prompt. These fields may be removed in a later cleanup.

- voice_sample_text is marked with a privacy annotation matching the pattern
  in voice_fingerprint.py. It must never be logged or returned to the caller.

- story is passed as a plain dict (not the Story Pydantic model) to avoid a
  circular import. The generator accesses fields by key lookup.
"""
from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field

Provider = Literal["anthropic", "openai", "deepseek"]


class GenerateCoverLetterRequest(BaseModel):
    """
    Request body for POST /internal/generate-cover-letter.

    All inputs are resolved by the web route (auth, DB lookups, key decrypt)
    before this payload is sent to cv-backend.

    PRIVACY: voice_sample_text must not appear in logs. It contains the user's
    verbatim writing sample — personally identifying writing style. If request-body
    logging is ever added to this service, add voice_sample_text to the redaction
    list.
    """

    # ── Identity ───────────────────────────────────────────────────────────────
    letter_id: str = Field(description="UUID of the cover_letters row (pre-created by web route)")
    user_id:   str = Field(description="User UUID — used for Supabase service-role writes")
    job_id:    str = Field(description="Job UUID — logged for audit, not used by generator")

    # ── JD + CV inputs ─────────────────────────────────────────────────────────
    jd_text:      str = Field(min_length=1, description="Full job description text")
    role:         str = Field(min_length=1, description="Job title extracted from JD or job row")
    company_name: str = Field(min_length=1, description="Company name from the job row")
    cv_text:      str = Field(min_length=1, description="Candidate's master CV plain text")

    # ── Voice profile inputs ───────────────────────────────────────────────────
    # voice_sample_text: DO NOT LOG. See privacy annotation above.
    voice_sample_text: str = Field(
        min_length=1,
        description="Verbatim writing sample (150-200 words). NEVER logged.",
    )
    fingerprint: Dict[str, Any] = Field(
        description="14-key VoiceFingerprint dict from voice_profiles.fingerprint"
    )

    # ── Story input ────────────────────────────────────────────────────────────
    story: Dict[str, Any] = Field(
        description=(
            "Serialised Story dict: title, domain, year, one_line, detailed, numbers, tags. "
            "The web route selects the top-scoring story from the match endpoint."
        )
    )

    # ── Company fact ───────────────────────────────────────────────────────────
    company_hook_text: str = Field(
        min_length=1,
        description="The ONE selected company fact used as the paragraph 1 opener.",
    )

    # ── Generation parameters ──────────────────────────────────────────────────
    tone_target:      Literal["professional", "warm", "direct"] = Field(default="professional")
    word_count_target: int = Field(default=170, ge=100, le=400)

    # ── AI provider ────────────────────────────────────────────────────────────
    ai_provider: Provider
    ai_api_key:  str = Field(min_length=1, description="Decrypted BYOK key. Not logged.")
    ai_model:    Optional[str] = Field(
        default=None,
        description=(
            "The user's chosen model. Used for both the generation call and "
            "the honesty gate. Falls back to a provider-specific default if None."
        ),
    )


class GenerateCoverLetterResponse(BaseModel):
    """Response from POST /internal/generate-cover-letter."""

    letter_id: str = Field(description="UUID of the cover_letters row")
    status:    Literal["accepted"] = "accepted"
