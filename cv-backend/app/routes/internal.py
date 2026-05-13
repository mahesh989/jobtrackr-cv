"""
Internal API consumed exclusively by JobTrackr's Next.js routes.

All endpoints require an HMAC-SHA256 signature in X-Signature, computed with
the shared JOBTRACKR_HMAC_SECRET. There is no other auth surface — these
routes are not exposed to browsers and cv-backend is not on a public domain.

Three endpoints:
  - POST /internal/analyze         → kicks off the 7-step pipeline (Phase 5)
  - POST /internal/extract-cv-text → returns pypdf text for a Storage object
  - POST /internal/scrape-jd       → returns scraped JD text for a URL

At this commit (2c) the endpoints validate input + HMAC and return placeholder
responses. Real wiring lands in 2d (AI client) + 2e (pipeline + scraper).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, status

from app.schemas.internal import (
    AnalyzeRequest,
    AnalyzeResponse,
    ExtractCvTextRequest,
    ExtractCvTextResponse,
    ScrapeJdRequest,
    ScrapeJdResponse,
)
from app.security.hmac import verify_hmac

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/internal",
    tags=["internal"],
    dependencies=[Depends(verify_hmac)],
)


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
    Accept a pipeline run trigger. Returns immediately; the pipeline executes
    as a FastAPI BackgroundTask. cv-backend writes step results to the
    analysis_runs row identified by body.run_id via Supabase service-role.
    """
    logger.info(
        "received run %s (user=%s provider=%s jd_len=%d cv_len=%d)",
        body.run_id, body.user_id, body.ai_provider,
        len(body.jd_text), len(body.cv_text),
    )
    # 2d/2e: schedule background pipeline task here.
    # background_tasks.add_task(run_analysis_pipeline, ...payload...)
    return AnalyzeResponse(run_id=body.run_id)


# ── /internal/extract-cv-text ────────────────────────────────────────────────

@router.post("/extract-cv-text", response_model=ExtractCvTextResponse)
async def extract_cv_text(body: ExtractCvTextRequest) -> ExtractCvTextResponse:
    """Download a PDF from Supabase Storage and return its plain-text extraction."""
    logger.info("extract-cv-text stub: %s", body.storage_path)
    # 2e: real pypdf extraction (wrapped in asyncio.to_thread).
    return ExtractCvTextResponse(cv_text="", word_count=0)


# ── /internal/scrape-jd ──────────────────────────────────────────────────────

@router.post("/scrape-jd", response_model=ScrapeJdResponse)
async def scrape_jd(body: ScrapeJdRequest) -> ScrapeJdResponse:
    """Scrape a job-posting URL for the cleaned JD text."""
    logger.info("scrape-jd stub: %s", body.url)
    # 2e: call services/scraping/jd_scraper.scrape_jd.
    return ScrapeJdResponse(
        jd_text="",
        job_title=None,
        source_url=str(body.url),
    )
