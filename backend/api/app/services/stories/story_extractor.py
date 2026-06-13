"""
Story extraction service — Phase 10.2.a of the cover letter feature.

Calls the user's AI provider (BYOK) to extract structured achievement stories
from a master CV. Validates each story in the model's response against the
Story Pydantic schema before returning.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY BOUNDARY — cv_text handling
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - Sent to the AI provider for story extraction only.
  - NEVER logged in plaintext. This function emits no log statements that
    include the raw cv_text argument. Callers must not log the `cv_text`
    parameter. Error log lines include only character counts, story indices,
    and truncated schema-validation errors — never CV content.
  - NEVER returned to the client after initial submission. The GET endpoint
    for stories (Phase 10.2.b) returns structured Story objects only; the
    source cv_text is never re-exposed through this feature's response paths.
  - NEVER stored in cv-backend's database or filesystem. cv-backend writes
    the extracted Story objects to Supabase via service-role; cv_text is
    not written anywhere by this service.
  - no_training=True is set on every AI call (OpenAI store=False, Anthropic
    equivalent where supported by the SDK). This flag is passed through
    AIClient.complete_json → AIClient.complete → provider-specific call.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from pydantic import ValidationError

from app.schemas.stories import Story
from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts.cover_letter.story_extraction import (
    STORY_EXTRACTION_SYSTEM,
    STORY_EXTRACTION_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)

# Hard ceiling on CV text sent to the model — generous enough for a 6-page
# senior CV (~12,000 chars ≈ 2,500 tokens). Prevents runaway token usage on
# unexpectedly large or malformed CV pastes. Truncation removes the tail of
# the CV text (earlier roles are typically richer in detail for senior profiles).
_MAX_CV_CHARS = 12_000


async def extract_stories(
    client: AIClient,
    cv_text: str,
) -> dict:
    """
    Extract structured achievement stories from a master CV.

    Returns a dict with keys:
        stories    — list of Story dicts (validated; may be empty)
        diagnostic — str explaining why stories is empty, or None

    Raises:
        ValueError    — if cv_text is empty or whitespace-only
        AIClientError — if the model call fails, times out, or returns
                        a response that fails Pydantic schema validation

    Privacy: cv_text must not appear in any log call in this function.
    Only metadata (character count, word count, story index) is logged.
    """
    if not cv_text or not cv_text.strip():
        raise ValueError("cv_text is empty — cannot extract stories.")

    # Log metadata only — never the raw CV content (privacy boundary above).
    logger.info(
        "story extraction: cv_len=%d chars, cv_words=%d",
        len(cv_text),
        len(cv_text.split()),
    )

    truncated = cv_text[:_MAX_CV_CHARS]
    user_prompt = STORY_EXTRACTION_USER_TEMPLATE.format(cv_text=truncated)

    # Shared extraction_timestamp for the entire batch.
    # All stories extracted in this call receive the same value, enabling
    # batch-identification queries in Phase 10.2.b:
    #   WHERE user_id = ? AND extraction_timestamp = (SELECT MAX(extraction_timestamp)
    #                                                  FROM stories WHERE user_id = ?)
    # Set here rather than relying on a DB default so the value is consistent
    # across the batch even if individual INSERTs land at slightly different times.
    extraction_timestamp = datetime.now(timezone.utc)

    raw = await client.complete_json(
        system=STORY_EXTRACTION_SYSTEM,
        user=user_prompt,
        max_tokens=2_048,
        temperature=0.1,
        no_training=True,
    )

    raw_stories: list = raw.get("stories", [])
    diagnostic: str | None = raw.get("diagnostic") or None

    # Empty result — model found no distinct achievements in the CV.
    if not raw_stories:
        fallback_diagnostic = diagnostic or "No distinct achievements found in CV."
        logger.info(
            "story extraction: empty result — diagnostic=%r",
            fallback_diagnostic,
        )
        return {"stories": [], "diagnostic": fallback_diagnostic}

    # Full Pydantic validation on each story dict — not just key presence.
    # extraction_timestamp is injected here; the model is not asked to return it.
    #
    # On failure: log the raw story dict (truncated, server-side only) and raise
    # a generic AIClientError with NO model output in the message. Models can
    # regurgitate input text in malformed responses; echoing that excerpt in
    # the HTTP 502 body could leak cv_text back to the caller.
    validated: list[Story] = []
    for i, raw_story in enumerate(raw_stories):
        # Strip extraction_timestamp if the model somehow included it; we own
        # this value and must not let the model override it.
        raw_story_clean = {
            k: v for k, v in raw_story.items() if k != "extraction_timestamp"
        }
        try:
            story = Story(extraction_timestamp=extraction_timestamp, **raw_story_clean)
            validated.append(story)
        except ValidationError as exc:
            logger.error(
                "story extraction: story[%d] schema validation failed: %s "
                "— raw story (truncated): %.300s",
                i,
                exc,
                raw_story_clean,
            )
            raise AIClientError(
                f"Story {i} in extraction response did not match expected schema. "
                "Check server logs for the raw model output."
            ) from exc

    logger.info("story extraction: extracted %d validated stories", len(validated))
    return {
        "stories": [s.model_dump() for s in validated],
        "diagnostic": None,
    }
