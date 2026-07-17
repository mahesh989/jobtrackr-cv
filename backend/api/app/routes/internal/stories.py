from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from app.schemas.internal import (
    ExtractStoriesRequest,
)
from app.schemas.stories import (
    ExtractStoriesResponse,
    MatchStoriesRequest,
    MatchStoriesResponse,
    ScoredStory,
)
from app.services.ai.client import AIClientError, make_ai_client
from app.services.stories.story_extractor import extract_stories
from app.services.stories.story_matcher import score_stories

logger = logging.getLogger(__name__)

router = APIRouter()

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
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    try:
        result = await extract_stories(ai_client, body.cv_text)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Story extraction failed: {exc}",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    return ExtractStoriesResponse(
        stories=result["stories"],
        diagnostic=result["diagnostic"],
    )


# ── /internal/match-stories ──────────────────────────────────────────────────

@router.post("/match-stories", response_model=MatchStoriesResponse)
async def match_stories_endpoint(body: MatchStoriesRequest) -> MatchStoriesResponse:
    """
    Rank stories against a JD using deterministic keyword overlap. No AI call.

    Caller (web route) passes the user's current story batch (with DB ids set)
    and the JD text. Returns scored story ids sorted by relevance descending.
    The web route merges scores back onto the full story objects by id.

    jd_text is treated as PII-adjacent (contains employer details) — only
    its length is logged, never the raw content.
    """
    logger.info(
        "match-stories: jd_len=%d stories=%d",
        len(body.jd_text),
        len(body.stories),
    )
    raw_scored = score_stories(
        body.jd_text,
        [s.model_dump() for s in body.stories],
    )
    return MatchStoriesResponse(
        scored=[
            ScoredStory(story_id=item["story_id"], score=item["score"])
            for item in raw_scored
        ]
    )



