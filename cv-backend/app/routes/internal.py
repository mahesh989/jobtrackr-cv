"""
Internal API consumed exclusively by JobTrackr's Next.js routes.

All endpoints require an HMAC-SHA256 signature in X-Signature, computed with
the shared JOBTRACKR_HMAC_SECRET. cv-backend has no other auth surface and
is not exposed to browsers.

Endpoints:
  - POST /internal/analyze         — kicks off the pipeline (BackgroundTask)
  - POST /internal/extract-cv-text — pypdf extraction for a Storage object
  - POST /internal/scrape-jd       — JD scraping helper
"""
from __future__ import annotations

import asyncio
import io
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.config import get_settings
from app.database import get_supabase
from app.schemas.internal import (
    AnalyzeRequest,
    AnalyzeResponse,
    ExtractCvTextRequest,
    ExtractCvTextResponse,
    ScrapeJdRequest,
    ScrapeJdResponse,
)
from app.security.hmac import verify_hmac
from app.services.pipeline.orchestrator import run_analysis_pipeline
from app.services.scraping.jd_scraper import JDScrapeError, scrape_jd

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

def _extract_pdf_text_sync(pdf_bytes: bytes) -> str:
    """
    Sync pypdf extraction — must run in a worker thread so the event loop
    doesn't block on large PDFs.

    Fixes the original cv-magic bug: synchronous pypdf inside `async def`.
    """
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf_bytes))
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages.append(text)
    return "\n\n".join(pages).strip()


def _extract_docx_text_sync(docx_bytes: bytes) -> str:
    """Sync python-docx extraction. Run in a worker thread (see above)."""
    from docx import Document
    doc = Document(io.BytesIO(docx_bytes))
    paragraphs = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
    # Tables in CVs often hold contact lines + experience blocks — include them.
    for tbl in doc.tables:
        for row in tbl.rows:
            for cell in row.cells:
                if cell.text and cell.text.strip():
                    paragraphs.append(cell.text.strip())
    return "\n\n".join(paragraphs).strip()


@router.post("/extract-cv-text", response_model=ExtractCvTextResponse)
async def extract_cv_text(body: ExtractCvTextRequest) -> ExtractCvTextResponse:
    """Download a PDF from Supabase Storage and return its plain-text extraction."""
    settings = get_settings()
    bucket = settings.SUPABASE_CV_BUCKET

    # Path arrives in the form 'cvs/<user_id>/<cv_id>.pdf' — strip the bucket
    # prefix if it's been included by mistake.
    storage_key = body.storage_path
    prefix = f"{bucket}/"
    if storage_key.startswith(prefix):
        storage_key = storage_key[len(prefix):]

    # supabase-py is synchronous — wrap the download in a worker thread.
    def _download() -> bytes:
        return get_supabase().storage.from_(bucket).download(storage_key)

    try:
        file_bytes = await asyncio.to_thread(_download)
    except Exception as exc:
        logger.warning("extract-cv-text: download failed for %s: %s", storage_key, exc)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Could not fetch CV file: {exc}",
        ) from exc

    # Dispatch by extension. The Storage bucket only allows PDF + DOCX
    # (enforced at migration 013), so a stray .doc/.txt would be rejected
    # at upload time — but we still defensively check here.
    lower = storage_key.lower()
    if lower.endswith(".pdf"):
        cv_text = await asyncio.to_thread(_extract_pdf_text_sync, file_bytes)
    elif lower.endswith(".docx"):
        cv_text = await asyncio.to_thread(_extract_docx_text_sync, file_bytes)
    else:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file extension for {storage_key} (expected .pdf or .docx)",
        )

    word_count = len(cv_text.split())
    logger.info(
        "extract-cv-text: %s → %d chars, %d words",
        storage_key, len(cv_text), word_count,
    )
    return ExtractCvTextResponse(cv_text=cv_text, word_count=word_count)


# ── /internal/scrape-jd ──────────────────────────────────────────────────────

@router.post("/scrape-jd", response_model=ScrapeJdResponse)
async def scrape_jd_endpoint(body: ScrapeJdRequest) -> ScrapeJdResponse:
    """Scrape a job-posting URL for the cleaned JD text."""
    try:
        result = await scrape_jd(str(body.url))
    except JDScrapeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    return ScrapeJdResponse(
        jd_text=result.jd_text,
        job_title=result.job_title,
        source_url=result.source_url,
    )
