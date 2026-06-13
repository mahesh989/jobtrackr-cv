from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.schemas.internal import (
    ExtractVoiceFingerprintRequest,
    ExtractVoiceFingerprintResponse,
)
from app.services.ai.client import AIClientError, make_ai_client
from app.services.voice.voice_fingerprint import extract_voice_fingerprint
from app.schemas.cover_letter import (
    VoiceRewriteEmailRequest,
    VoiceRewriteEmailResponse,
)
from app.services.ai.prompts.cover_letter.voice_email import (
    VOICE_EMAIL_SYSTEM,
    VOICE_EMAIL_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)

router = APIRouter()

@router.post(
    "/extract-voice-fingerprint",
    response_model=ExtractVoiceFingerprintResponse,
)
async def extract_voice_fingerprint_endpoint(
    body: ExtractVoiceFingerprintRequest,
) -> ExtractVoiceFingerprintResponse:
    """
    Extract a structured voice fingerprint from a writing sample.

    Runs a deterministic trust score on the sample, then calls the user's
    AI provider (BYOK) to extract a 14-key fingerprint. Both the trust
    score and the fingerprint are returned; the caller (web API route) is
    responsible for persisting them to voice_profiles via service-role.

    NOTE: voice_sample_text must not appear in logs. If request-body logging
    is ever added to this service, add this field to the redaction list.
    """
    try:
        ai_client = make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    try:
        result = await extract_voice_fingerprint(ai_client, body.voice_sample_text)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Voice fingerprint extraction failed: {exc}",
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )

    return ExtractVoiceFingerprintResponse(
        fingerprint=result["fingerprint"],
        trust_score=result["trust_score"],
        trust_components=result["trust_components"],
        word_count=result["word_count"],
        matched_ai_phrases=result["matched_ai_phrases"],
    )


# ── /internal/extract-stories ────────────────────────────────────────────────


@router.post(
    "/voice-rewrite-email",
    response_model=VoiceRewriteEmailResponse,
    status_code=status.HTTP_200_OK,
)
async def voice_rewrite_email_endpoint(
    body: VoiceRewriteEmailRequest,
) -> VoiceRewriteEmailResponse:
    """
    Rewrite the SHORT email cover note that ships an application, in the
    candidate's voice. Synchronous — one AI call, returns the body text.

    The web tier calls this from /api/applications/[letter_id]/email-draft
    when the cached email_body is null and a voice_sample_raw exists. The
    result is cached in cover_letters.email_body so subsequent draft loads
    are instant.

    PRIVACY: body.voice_sample_text must not appear in logs.
    """
    logger.info(
        "voice-rewrite-email: user=%s letter=%s provider=%s job_title=%r company=%r",
        body.user_id, body.letter_id, body.ai_provider, body.job_title, body.company,
    )

    try:
        ai_client = make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid AI client configuration: {exc}",
        ) from exc

    user_prompt = VOICE_EMAIL_USER_TEMPLATE.format(
        voice_sample=body.voice_sample_text,
        boilerplate=body.boilerplate_body,
    )

    try:
        rewritten = await ai_client.complete(
            system=VOICE_EMAIL_SYSTEM,
            user=user_prompt,
            max_tokens=800,
            # Style transfer is more constrained than free-form generation —
            # we want the same meaning every time, just reshaped. Lower temp
            # also makes the AI less likely to drift into autobiography.
            temperature=0.3,
            no_training=True,
        )
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Voice rewrite failed: {exc}",
        ) from exc

    cleaned = rewritten.strip()
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Voice rewrite returned empty body",
        )

    return VoiceRewriteEmailResponse(body=cleaned)


# ── /internal/classify-skills ─────────────────────────────────────────────────


