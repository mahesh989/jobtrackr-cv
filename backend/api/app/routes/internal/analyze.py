from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, status

from app.schemas.internal import (
    AnalyzeRequest,
    AnalyzeResponse,
)
from app.services.pipeline.orchestrator import run_analysis_pipeline

logger = logging.getLogger(__name__)

router = APIRouter()

# ── /internal/analyze ─────────────────────────────────────────────────────────

@router.post(
    "/analyze",
    response_model=AnalyzeResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze(
    body: AnalyzeRequest,
    background_tasks: BackgroundTasks,
) -> AnalyzeResponse:
    """
    Accept a pipeline trigger. Returns 202 immediately; the pipeline runs as a
    FastAPI BackgroundTask and writes step results to analysis_runs.{run_id}
    via Supabase service-role.
    """
    logger.info(
        "received run %s (user=%s provider=%s jd_len=%d cv_len=%d)",
        body.run_id, body.user_id, body.ai_provider,
        len(body.jd_text), len(body.cv_text),
    )
    background_tasks.add_task(run_analysis_pipeline, body)
    return AnalyzeResponse(run_id=body.run_id)


# ── /internal/extract-cv-text ────────────────────────────────────────────────


