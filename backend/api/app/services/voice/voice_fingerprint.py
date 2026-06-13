"""
Voice fingerprint extraction service — Phase 1 of the cover letter feature.

Calls the user's AI provider (BYOK) to extract a structured fingerprint
from a writing sample. Validates the model's response against the
VoiceFingerprint Pydantic schema before returning.

PRIVACY BOUNDARY — voice_sample_raw handling:
  - Sent to the AI provider for fingerprint extraction only.
  - NEVER logged in plaintext. This function emits no log statements that
    include the raw sample; callers must not log the `voice_sample` argument.
  - NEVER returned to the client after initial submission. The GET endpoint
    in frontend/web/src/app/api/user/voice-profile/route.ts enforces this at the
    application layer (deliberately excluded from the SELECT query).
  - NEVER stored in cv-backend's database or filesystem.
  - API-level no-training flags (OpenAI store=False, Anthropic headers):
    AIClient.complete_json does not yet support per-call extra parameters.
    TODO Phase 1.5: extend AIClient to accept no_training=True and pass
    store=False (OpenAI) or the equivalent documented Anthropic header.
    Until then, privacy is enforced at the application and database layers:
    RLS on voice_profiles ensures per-user isolation; service-role writes
    never expose the raw text to other users or to unauthenticated paths.
"""
from __future__ import annotations

import logging

from pydantic import ValidationError

from app.schemas.voice import VoiceFingerprint
from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts.cover_letter.voice_fingerprint import (
    VOICE_FINGERPRINT_SYSTEM,
    VOICE_FINGERPRINT_USER_TEMPLATE,
)
from app.services.voice.trust_scorer import score as compute_trust

logger = logging.getLogger(__name__)

# Hard ceiling on sample text sent to the model — generous enough for
# 300-word samples (≈ 1 800 chars) with room for verbose writers.
# Prevents runaway token usage on unexpectedly large pastes.
_MAX_SAMPLE_CHARS = 4_000


async def extract_voice_fingerprint(
    client: AIClient,
    voice_sample: str,
) -> dict:
    """
    Extract a voice fingerprint from a writing sample.

    Returns a dict with keys:
        fingerprint        — VoiceFingerprint as a plain dict (14 keys)
        trust_score        — float 0.0–1.0
        trust_components   — dict with the three component scores
        word_count         — int
        matched_ai_phrases — list[str] of AI-tell phrases found

    Raises:
        ValueError       — if voice_sample is empty
        AIClientError    — if the model call fails or returns an invalid schema
    """
    if not voice_sample or not voice_sample.strip():
        raise ValueError("voice_sample is empty — cannot extract fingerprint.")

    # Compute trust score deterministically before the model call.
    # NOTE: trust result is logged at INFO level without the raw text.
    trust = compute_trust(voice_sample)
    logger.info(
        "voice fingerprint: trust_score=%.3f (ai=%.3f var=%.3f len=%.3f) "
        "matched_phrases=%d word_count=%d",
        trust.overall_score,
        trust.ai_pattern_score,
        trust.sentence_variance_score,
        trust.length_appropriateness_score,
        len(trust.matched_ai_phrases),
        len(voice_sample.split()),
    )

    truncated = voice_sample[:_MAX_SAMPLE_CHARS]
    user_prompt = VOICE_FINGERPRINT_USER_TEMPLATE.format(voice_sample=truncated)

    raw = await client.complete_json(
        system=VOICE_FINGERPRINT_SYSTEM,
        user=user_prompt,
        max_tokens=1_024,
        temperature=0.2,
        no_training=True,
    )

    # Full Pydantic validation — not just key presence.
    # On failure: log the raw excerpt server-side for debugging, but raise a
    # generic AIClientError with NO model output in the message. Models can
    # regurgitate input text in malformed responses; echoing that excerpt in
    # the HTTP 502 body would leak voice_sample_raw back to the caller.
    try:
        fingerprint = VoiceFingerprint(**raw)
    except ValidationError as exc:
        logger.error(
            "voice fingerprint schema validation failed: %s — raw output (truncated): %.400s",
            exc, raw,
        )
        raise AIClientError(
            "Voice fingerprint response did not match expected schema. "
            "Check server logs for the raw model output."
        ) from exc

    return {
        "fingerprint": fingerprint.model_dump(),
        "trust_score": trust.overall_score,
        "trust_components": {
            "ai_pattern_score": trust.ai_pattern_score,
            "sentence_variance_score": trust.sentence_variance_score,
            "length_appropriateness_score": trust.length_appropriateness_score,
        },
        "word_count": len(voice_sample.split()),
        "matched_ai_phrases": trust.matched_ai_phrases,
    }
