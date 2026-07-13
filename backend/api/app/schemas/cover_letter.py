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

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.enums import Provider


class OpeningVariant(BaseModel):
    """One P1 opener option returned by /internal/generate-opening-variants."""

    id: str = Field(description="Pattern identifier: 'A', 'B', 'C', or 'D'")
    text: str = Field(min_length=1, description="The opener text (2-4 sentences, 30-60 words)")
    pattern_label: str = Field(description="Human-readable pattern name shown in the picker UI")


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

    # ── Phase 11: chosen opener ────────────────────────────────────────────────
    chosen_opening: Optional[str] = Field(
        default=None,
        description=(
            "If set, P1 is already chosen by the user. The generator writes "
            "only P2-4, then prepends chosen_opening as the first paragraph "
            "of the stored letter. Set by the /pick web route after the user "
            "selects a variant from the picker UI."
        ),
    )


class GenerateCoverLetterResponse(BaseModel):
    """Response from POST /internal/generate-cover-letter."""

    letter_id: str = Field(description="UUID of the cover_letters row")
    status:    Literal["accepted"] = "accepted"


class GenerateOpeningVariantsRequest(BaseModel):
    """
    Request body for POST /internal/generate-opening-variants.

    Identical inputs to GenerateCoverLetterRequest minus letter_id and
    chosen_opening — variants are generated before a letter row is fully
    committed to body generation. The web route resolves all inputs (auth,
    DB lookups, key decrypt) before calling cv-backend.

    PRIVACY: voice_sample_text must not appear in logs.
    """

    # ── Identity ───────────────────────────────────────────────────────────────
    user_id: str = Field(description="User UUID — logged for audit")
    job_id:  str = Field(description="Job UUID — logged for audit")

    # ── JD + CV inputs ─────────────────────────────────────────────────────────
    jd_text:      str = Field(min_length=1)
    role:         str = Field(min_length=1)
    company_name: str = Field(min_length=1)
    cv_text:      str = Field(min_length=1)

    # ── Voice profile inputs ───────────────────────────────────────────────────
    voice_sample_text: str = Field(min_length=1, description="Verbatim writing sample. NEVER logged.")
    fingerprint:       Dict[str, Any] = Field(description="14-key VoiceFingerprint dict")

    # ── Story input ────────────────────────────────────────────────────────────
    story: Dict[str, Any] = Field(description="Top-scored story dict (title, one_line, detailed, numbers)")

    # ── Company fact ───────────────────────────────────────────────────────────
    company_hook_text: str = Field(min_length=1, description="The selected company fact for paragraph 2")

    # ── AI provider ────────────────────────────────────────────────────────────
    ai_provider: Provider
    ai_api_key:  str = Field(min_length=1, description="Decrypted BYOK key. Not logged.")
    ai_model:    Optional[str] = Field(default=None)


class GenerateOpeningVariantsResponse(BaseModel):
    """Response from POST /internal/generate-opening-variants."""

    variants: List[OpeningVariant] = Field(
        description="3-4 structurally distinct P1 openers, one per named pattern"
    )


# ── /internal/voice-rewrite-email ─────────────────────────────────────────────


class VoiceRewriteEmailRequest(BaseModel):
    """
    Request body for POST /internal/voice-rewrite-email.

    This is a STYLE TRANSFER call. The web tier supplies both the voice
    sample (style donor) and the boilerplate body to rewrite (content
    source-of-truth). The AI is forbidden from importing content from the
    voice sample — see voice_email.py prompt for the full ruleset.

    Cached in cover_letters.email_body so subsequent modal opens are instant.

    PRIVACY: voice_sample_text and boilerplate_body must not appear in logs.
    """

    user_id:           str = Field(description="User UUID — logged for audit")
    letter_id:         str = Field(description="Cover letter UUID — logged for audit")

    # Kept for prompt context + logging only; the AI does not invent against
    # these — meaning lives in boilerplate_body.
    job_title:         str = Field(min_length=1)
    company:           str = Field(min_length=1)
    hiring_manager:    Optional[str] = Field(default=None)
    user_name:         Optional[str] = Field(default=None)

    voice_sample_text: str = Field(min_length=1, description="Verbatim writing sample. NEVER logged.")

    # The boilerplate body to rewrite. The AI preserves its meaning, paragraph
    # count, and order — only the rhythm/phrasing/formality changes.
    boilerplate_body:  str = Field(min_length=1, description="Boilerplate email body. NEVER logged.")

    ai_provider: Provider
    ai_api_key:  str = Field(min_length=1, description="Decrypted BYOK key. Not logged.")
    ai_model:    Optional[str] = Field(default=None)


class VoiceRewriteEmailResponse(BaseModel):
    """Response from POST /internal/voice-rewrite-email."""

    body: str = Field(min_length=1, description="The rewritten email body text. No subject line, no markdown.")
