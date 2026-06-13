from __future__ import annotations

import logging

from fastapi import APIRouter, status

from app.schemas.internal import (
    ClassifiedSkillItem,
    ClassifySkillsRequest,
    ClassifySkillsResponse,
)

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
    from app.services.skills.classifier import classify as lex_classify, is_noise as lex_is_noise

    results = []
    for item in body.items:
        c = lex_classify(item, body.vertical)
        n = lex_is_noise(item)
        if n:
            action = "should_be_stripped"
        elif c and c.is_skill and c.category == "domain_knowledge":
            action = "should_be_care_skills"
        elif c and c.is_skill and c.category == "technical":
            action = "correct_technical"
        elif c and c.is_skill:
            action = "correct"
        else:
            action = "add_to_lexicon"

        results.append(ClassifiedSkillItem(
            item=item,
            category=c.category if c and c.is_skill else None,
            canonical=c.canonical if c and c.is_skill else None,
            is_noise=n,
            action=action,
        ))

    return ClassifySkillsResponse(results=results)

