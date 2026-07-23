from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, status

from app.routes.internal._helpers import build_ai_client_or_422
from app.services.ai.client import AIClientError
from app.schemas.cover_letter import (
    GenerateCoverLetterRequest,
    GenerateCoverLetterResponse,
    GenerateOpeningVariantsRequest,
    GenerateOpeningVariantsResponse,
)
from app.services.cover_letter.generator import run_cover_letter_pipeline
from app.services.cover_letter.variants import generate_opening_variants

logger = logging.getLogger(__name__)

router = APIRouter()

@router.post(
    "/generate-opening-variants",
    response_model=GenerateOpeningVariantsResponse,
    status_code=status.HTTP_200_OK,
)
async def generate_opening_variants_endpoint(
    body: GenerateOpeningVariantsRequest,
) -> GenerateOpeningVariantsResponse:
    """
    Generate 3-4 structurally distinct P1 openers in a single AI call.

    Unlike /generate-cover-letter this endpoint is synchronous — it returns
    the variants in the response body (typical latency: 5-15 s). The caller
    (web /cover-letter POST route) stores the variants in the cover_letters
    row and returns them to the browser for the picker UI.

    NOTE: body.voice_sample_text must not appear in logs.
    """
    logger.info(
        "generate-opening-variants: user=%s job=%s provider=%s",
        body.user_id, body.job_id, body.ai_provider,
    )

    ai_client = build_ai_client_or_422(body, detail_prefix="Invalid AI client configuration: ")

    try:
        variants = await generate_opening_variants(ai_client, body)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Opening variants generation failed: {exc}",
        ) from exc

    return GenerateOpeningVariantsResponse(variants=variants)


# ── /internal/generate-cover-letter ───────────────────────────────────────────

@router.post(
    "/generate-cover-letter",
    response_model=GenerateCoverLetterResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def generate_cover_letter(
    body: GenerateCoverLetterRequest,
    background_tasks: BackgroundTasks,
) -> GenerateCoverLetterResponse:
    """
    Accept a cover letter generation trigger. Returns 202 immediately.

    The three-pass pipeline (skeleton → voice transfer → burstiness) runs as a
    FastAPI BackgroundTask and writes progress + outputs to cover_letters.{letter_id}
    via Supabase service-role. The browser subscribes to postgres_changes on
    cover_letters for real-time progress (same pattern as analysis_runs).

    NOTE: body.voice_sample_text must not appear in logs. See GenerateCoverLetterRequest
    privacy annotation.
    """
    logger.info(
        "generate-cover-letter: letter_id=%s user=%s provider=%s jd_len=%d",
        body.letter_id, body.user_id, body.ai_provider, len(body.jd_text),
    )
    background_tasks.add_task(run_cover_letter_pipeline, body)
    return GenerateCoverLetterResponse(letter_id=body.letter_id)


# ── /internal/voice-rewrite-email ─────────────────────────────────────────────


