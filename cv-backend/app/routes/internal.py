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
    CategoriseCvRequest,
    CategoriseCvResponse,
    ExtractCvTextRequest,
    ExtractCvTextResponse,
    ExtractStoriesRequest,
    ExtractVoiceFingerprintRequest,
    ExtractVoiceFingerprintResponse,
    ScrapeJdRequest,
    ScrapeJdResponse,
)
from app.schemas.stories import ExtractStoriesResponse
from app.security.hmac import verify_hmac
from app.services.ai.client import AIClientError, make_ai_client
from app.services.cv.skill_categoriser import categorise_cv_skills
from app.services.stories.story_extractor import extract_stories
from app.services.voice.voice_fingerprint import extract_voice_fingerprint
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

@router.post("/categorise-cv", response_model=CategoriseCvResponse)
async def categorise_cv(body: CategoriseCvRequest) -> CategoriseCvResponse:
    """
    BYOK skill categorisation. Returns three lists — technical / soft_skills /
    domain_knowledge — extracted from the provided CV text by the AI provider
    the user has connected. JobTrackr calls this once at CV upload time.
    """
    try:
        ai_client = make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    try:
        result = await categorise_cv_skills(ai_client, body.cv_text)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI categorisation failed: {exc}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    return CategoriseCvResponse(
        technical=        result.get("technical", []),
        soft_skills=      result.get("soft_skills", []),
        domain_knowledge= result.get("domain_knowledge", []),
    )


# ── /internal/extract-voice-fingerprint ──────────────────────────────────────

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
    "/extract-stories",
    response_model=ExtractStoriesResponse,
)
async def extract_stories_endpoint(
    body: ExtractStoriesRequest,
) -> ExtractStoriesResponse:
    """
    Extract structured achievement stories from a master CV.

    Calls the user's AI provider (BYOK) to identify 3–8 distinct achievements
    suitable for use as cover letter narratives. Validates each story against
    the Story Pydantic schema before returning. Returns HTTP 200 with an empty
    stories list and a diagnostic message if no achievements are found — this
    is not an error condition.

    NOTE: body.cv_text must not appear in logs. If request-body logging is
    ever added to this service, add cv_text to the redaction list.
    """
    try:
        ai_client = make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    try:
        result = await extract_stories(ai_client, body.cv_text)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Story extraction failed: {exc}",
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )

    return ExtractStoriesResponse(
        stories=result["stories"],
        diagnostic=result["diagnostic"],
    )


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
