from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.config import get_settings
from app.enums import CompanyResearchStatus
from app.routes.internal._helpers import build_ai_client_or_422
from app.services.company.researcher import CompanyResearchError, research_company
from app.services.company.fact_selector import select_facts
from app.schemas.company import (
    ResearchCompanyRequest,
    ResearchCompanyResponse,
    CompanyResearch,
    SelectCompanyFactRequest,
    SelectCompanyFactResponse,
    RankedFact,
)

logger = logging.getLogger(__name__)

router = APIRouter()

@router.post(
    "/research-company",
    response_model=ResearchCompanyResponse,
    status_code=status.HTTP_200_OK,
)
async def research_company_endpoint(body: ResearchCompanyRequest) -> ResearchCompanyResponse:
    """
    Research a company via Tavily + scraping + AI distillation.

    Returns the completed CompanyResearch synchronously (unlike /analyze
    which uses BackgroundTasks). Caller (web route) writes the result to
    Supabase and handles TTL/cache logic. Typical latency: 15–45 s.

    company_name length is logged; company_domain and ai_api_key are not.
    """
    settings = get_settings()

    logger.info(
        "research-company: company=%r domain_hint=%s provider=%s",
        body.company_name,
        bool(body.company_domain),
        body.ai_provider,
    )

    ai_client = build_ai_client_or_422(body, detail_prefix="Invalid AI client configuration: ")

    try:
        result_dict = await research_company(
            client=ai_client,
            company_name=body.company_name,
            company_domain=body.company_domain,
            tavily_api_key=settings.TAVILY_API_KEY or None,
            jd_location=body.jd_location,
        )
    except CompanyResearchError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    research = CompanyResearch(**result_dict)
    return ResearchCompanyResponse(
        company_id=research.company_id,
        status=CompanyResearchStatus.COMPLETED,
        research=research,
        search_skipped=research.search_skipped,
    )


# ── /internal/select-company-fact ─────────────────────────────────────────────

@router.post(
    "/select-company-fact",
    response_model=SelectCompanyFactResponse,
    status_code=status.HTTP_200_OK,
)
async def select_company_fact_endpoint(body: SelectCompanyFactRequest) -> SelectCompanyFactResponse:
    """
    Rank company facts by keyword relevance to JD + CV. No AI call.

    Deterministic — same inputs always produce the same ranking.
    jd_text and cv_text lengths are logged; content is not.
    """
    logger.info(
        "select-company-fact: company_id=%r jd_len=%d cv_len=%d",
        body.company_id,
        len(body.jd_text),
        len(body.cv_text),
    )
    ranked = select_facts(
        jd_text=body.jd_text,
        cv_text=body.cv_text,
        facts=body.facts,
        jd_location=body.jd_location,
    )
    return SelectCompanyFactResponse(
        ranked_facts=[
            RankedFact(
                fact_text=item["fact_text"],
                score=item["score"],
                source_field=item["source_field"],
            )
            for item in ranked
        ]
    )


# ── /internal/generate-opening-variants ───────────────────────────────────────


