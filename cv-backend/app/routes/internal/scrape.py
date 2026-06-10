from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.schemas.internal import (
    ScrapeJdRequest,
    ScrapeJdResponse,
)
from app.services.scraping.jd_scraper import JDScrapeError, scrape_jd

logger = logging.getLogger(__name__)

router = APIRouter()

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


# ── /internal/research-company ────────────────────────────────────────────────


