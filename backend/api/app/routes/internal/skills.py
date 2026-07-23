from __future__ import annotations

import logging

from fastapi import APIRouter, status

from app.schemas.internal import (
    ClassifiedSkillItem,
    ClassifySkillsRequest,
    ClassifySkillsResponse,
)
from app.services.skills.audit_actions import classify_audit_items

logger = logging.getLogger(__name__)

router = APIRouter()

@router.post(
    "/classify-skills",
    response_model=ClassifySkillsResponse,
    status_code=status.HTTP_200_OK,
)
async def classify_skills_endpoint(body: ClassifySkillsRequest) -> ClassifySkillsResponse:
    """
    Deterministic skill classification — no AI call.

    Runs each item through the lexicon classify() + is_noise() and returns
    the result. Used by the /beta/skills-audit page to show per-item
    category assignments without re-running a full analysis.
    """
    results = classify_audit_items(body.items, body.vertical)
    return ClassifySkillsResponse(
        results=[ClassifiedSkillItem(**r) for r in results]
    )

