"""
Company / job-description endpoints.
A "company" is the container for a job posting — it holds the JD text and
all analysis runs linked to it.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import CurrentUser, get_current_user
from app.database import get_db
from app.models.company import Company
from app.schemas.company import (
    CompanyCreate,
    CompanyOut,
    CompanyUpdate,
    JDScrapeRequest,
    JDScrapeResponse,
)
from app.services.scraping.jd_scraper import JDScrapeError, scrape_jd

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/companies", tags=["companies"])
_VALID_STATUSES = {"saved", "applied", "interviewing", "rejected", "offered"}


def _jd_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@router.get("", response_model=list[CompanyOut])
async def list_companies(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CompanyOut]:
    query = select(Company).where(Company.user_id == current_user.id)
    if status_filter is not None:
        if status_filter not in _VALID_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid status '{status_filter}'. Valid values: {sorted(_VALID_STATUSES)}",
            )
        query = query.where(Company.status == status_filter)

    query = query.order_by(Company.created_at.desc())
    result = await db.execute(query)
    return [CompanyOut.model_validate(c) for c in result.scalars().all()]


@router.post("/scrape-jd", response_model=JDScrapeResponse)
async def scrape_jd_endpoint(
    body: JDScrapeRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> JDScrapeResponse:
    """Fetch a job posting URL and extract its JD text + best-effort title.

    Auth-required so we can't be used as an open proxy. Returns 422 with a
    user-friendly detail when the page can't be parsed (e.g. JS-only pages,
    login-required sites).
    """
    try:
        result = await scrape_jd(str(body.url))
    except JDScrapeError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e),
        )
    return JDScrapeResponse(
        jd_text=result.jd_text,
        job_title=result.job_title,
        source_url=result.source_url,
    )


@router.post("", response_model=CompanyOut, status_code=status.HTTP_201_CREATED)
async def create_company(
    body: CompanyCreate,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CompanyOut:
    if body.status not in _VALID_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid status '{body.status}'. Valid values: {sorted(_VALID_STATUSES)}",
        )
    company = Company(
        user_id=current_user.id,
        display_name=body.display_name,
        job_url=body.job_url,
        job_title=body.job_title,
        jd_text=body.jd_text,
        jd_hash=_jd_hash(body.jd_text) if body.jd_text else None,
        status=body.status,
        notes=body.notes,
    )
    db.add(company)
    await db.commit()
    await db.refresh(company)
    return CompanyOut.model_validate(company)


@router.get("/{company_id}", response_model=CompanyOut)
async def get_company(
    company_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CompanyOut:
    result = await db.execute(
        select(Company).where(
            Company.id == company_id, Company.user_id == current_user.id
        )
    )
    company = result.scalar_one_or_none()
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    return CompanyOut.model_validate(company)


@router.patch("/{company_id}", response_model=CompanyOut)
async def update_company(
    company_id: uuid.UUID,
    body: CompanyUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CompanyOut:
    result = await db.execute(
        select(Company).where(
            Company.id == company_id, Company.user_id == current_user.id
        )
    )
    company = result.scalar_one_or_none()
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")

    if body.status is not None and body.status not in _VALID_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid status '{body.status}'. Valid values: {sorted(_VALID_STATUSES)}",
        )

    if body.display_name is not None:
        company.display_name = body.display_name
    if body.job_url is not None:
        company.job_url = body.job_url
    if body.job_title is not None:
        company.job_title = body.job_title
    if body.jd_text is not None:
        company.jd_text = body.jd_text
        company.jd_hash = _jd_hash(body.jd_text)
    if body.status is not None:
        company.status = body.status
    if body.notes is not None:
        company.notes = body.notes

    await db.commit()
    await db.refresh(company)
    return CompanyOut.model_validate(company)


@router.delete("/{company_id}", status_code=status.HTTP_200_OK)
async def delete_company(
    company_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Company).where(
            Company.id == company_id, Company.user_id == current_user.id
        )
    )
    company = result.scalar_one_or_none()
    if company is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
    await db.delete(company)
    await db.commit()
