"""
Analysis run endpoints.

Triggering an analysis:
  POST /analysis-runs  →  create the run row (status=pending), enqueue background task
  GET  /analysis-runs  →  list runs for the current user
  GET  /analysis-runs/{id}  →  get a single run (frontend polls this or uses Realtime)

The actual pipeline (6 steps) is executed in a background task so the HTTP
response returns immediately.  The frontend subscribes to Supabase Realtime
for live step_status updates.
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.dependencies import CurrentUser, get_current_user
from app.core.quota import check_quota
from app.database import get_db, get_supabase
from app.models.analysis_run import AnalysisRun
from app.models.company import Company
from app.models.cv_version import CVVersion
from app.schemas.analysis_run import AnalysisRunCreate, AnalysisRunOut
from app.services.pipeline import run_analysis_pipeline

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/analysis-runs", tags=["analysis-runs"])


async def _run_pipeline(run_id: uuid.UUID) -> None:
    """Background-task wrapper around the real pipeline orchestrator."""
    await run_analysis_pipeline(run_id)


@router.get("", response_model=list[AnalysisRunOut])
async def list_analysis_runs(
    company_id: Optional[uuid.UUID] = None,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AnalysisRunOut]:
    query = select(AnalysisRun).where(AnalysisRun.user_id == current_user.id)
    if company_id is not None:
        query = query.where(AnalysisRun.company_id == company_id)
    query = query.order_by(AnalysisRun.created_at.desc())
    result = await db.execute(query)
    return [AnalysisRunOut.model_validate(r) for r in result.scalars().all()]


@router.post("", response_model=AnalysisRunOut, status_code=status.HTTP_201_CREATED)
async def create_analysis_run(
    body: AnalysisRunCreate,
    background_tasks: BackgroundTasks,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AnalysisRunOut:
    # 1. Quota check (raises HTTP 402 if over limit)
    await check_quota(current_user.id, db)

    # 2. Verify company ownership
    company_result = await db.execute(
        select(Company).where(
            Company.id == body.company_id, Company.user_id == current_user.id
        )
    )
    company = company_result.scalar_one_or_none()
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")

    if not company.jd_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Company has no job description text — add a JD before running analysis",
        )

    # 3. Verify cv_version ownership
    cv_result = await db.execute(
        select(CVVersion).where(
            CVVersion.id == body.cv_version_id, CVVersion.user_id == current_user.id
        )
    )
    cv_version = cv_result.scalar_one_or_none()
    if cv_version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="CV version not found")

    # 4. Mark previous runs for this (user, company) as stale
    prev_result = await db.execute(
        select(AnalysisRun).where(
            AnalysisRun.user_id == current_user.id,
            AnalysisRun.company_id == body.company_id,
            AnalysisRun.is_stale == False,  # noqa: E712
        )
    )
    for prev_run in prev_result.scalars().all():
        prev_run.is_stale = True

    # 5. Create new run
    run = AnalysisRun(
        user_id=current_user.id,
        company_id=body.company_id,
        cv_version_id=body.cv_version_id,
        status="pending",
    )
    db.add(run)
    await db.flush()  # get id before commit

    await db.commit()
    await db.refresh(run)

    # 6. Kick off background pipeline.  Quota is incremented inside the
    #    pipeline only AFTER the tailored CV step succeeds — failed runs
    #    do not consume a credit.
    background_tasks.add_task(_run_pipeline, run.id)

    return AnalysisRunOut.model_validate(run)


@router.get("/{run_id}", response_model=AnalysisRunOut)
async def get_analysis_run(
    run_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AnalysisRunOut:
    result = await db.execute(
        select(AnalysisRun).where(
            AnalysisRun.id == run_id, AnalysisRun.user_id == current_user.id
        )
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis run not found")
    return AnalysisRunOut.model_validate(run)


@router.get("/{run_id}/tailored-cv")
async def download_tailored_cv(
    run_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """
    Download the tailored CV markdown produced by the pipeline.
    Returns the raw markdown bytes with `text/markdown` content-type.
    The frontend can render it for preview or convert to PDF client-side.
    """
    result = await db.execute(
        select(AnalysisRun).where(
            AnalysisRun.id == run_id, AnalysisRun.user_id == current_user.id
        )
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis run not found")
    if not run.tailored_cv_storage_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tailored CV not yet generated for this run",
        )

    settings = get_settings()
    supabase = get_supabase()
    try:
        data = supabase.storage.from_(settings.SUPABASE_TAILORED_CV_BUCKET).download(
            run.tailored_cv_storage_path
        )
    except Exception as exc:
        logger.exception("Failed to fetch tailored CV from storage: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not fetch tailored CV from storage",
        )

    return Response(
        content=data,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="tailored-cv-{run_id}.md"'},
    )


@router.get("/{run_id}/tailored-cv/pdf")
async def download_tailored_cv_pdf(
    run_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """
    Download the tailored CV as a properly formatted A4 PDF.

    Fetches the stored markdown, converts it to PDF via ReportLab
    (Calibri if available, Helvetica fallback), and streams the bytes.
    """
    result = await db.execute(
        select(AnalysisRun).where(
            AnalysisRun.id == run_id, AnalysisRun.user_id == current_user.id
        )
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis run not found")
    if not run.tailored_cv_storage_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tailored CV not yet generated for this run",
        )

    settings = get_settings()
    supabase = get_supabase()
    try:
        markdown_bytes = supabase.storage.from_(settings.SUPABASE_TAILORED_CV_BUCKET).download(
            run.tailored_cv_storage_path
        )
    except Exception as exc:
        logger.exception("Failed to fetch tailored CV from storage: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not fetch tailored CV from storage",
        )

    try:
        from app.services.cv.pdf_generator import generate_pdf_from_markdown
        markdown = markdown_bytes.decode("utf-8")
        pdf_bytes = generate_pdf_from_markdown(markdown)
    except Exception as exc:
        logger.exception("PDF generation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="PDF generation failed",
        )

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="tailored-cv-{run_id}.pdf"'},
    )
