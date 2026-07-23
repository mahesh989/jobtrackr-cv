"""Pydantic schemas for story extraction — Phase 10.2.a.

Import path: app.schemas.stories
Shared across extraction (Phase 10.2.a) and matching (Phase 10.2.b).

Design notes:
- StoryNumber enforces {metric, value} shape at the Pydantic layer — not raw dicts.
  Models occasionally return numbers as plain strings; this schema forces callers
  to be explicit.
- year is Optional[int] — junior/pre-professional experience may not map to a
  clear calendar year. Bounded ge=1950, le=2030 to catch obvious model errors.
- tags is list[str] with an advisory vocabulary in the extraction prompt. Kept
  as plain strings (not a Literal enum) so Phase 10.2.b can extend tag categories
  without a schema migration.
- extraction_timestamp is a datetime object (timezone-aware UTC) set by
  cv-backend before insertion. All rows in a batch share the same value,
  enabling batch queries: WHERE user_id = ? AND extraction_timestamp = MAX(...).
  It is stamped by story_extractor.py, never by DB default (no DEFAULT in
  migration 022), to guarantee batch consistency. FastAPI serialises it to
  ISO 8601 in HTTP responses; the web layer inserts it as a timestamptz string.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class StoryNumber(BaseModel):
    """A concrete, quantified metric extracted from a CV achievement."""

    metric: str = Field(
        min_length=1,
        description="What was measured — e.g. 'Missed shifts', 'Page load time'",
    )
    value: str = Field(
        min_length=1,
        description="The concrete value — e.g. 'reduced by 40%', 'cut from 8.2s to 1.1s'",
    )


class Story(BaseModel):
    """
    A single achievement story extracted from a master CV.

    The extraction service validates each model-returned story dict against
    this schema. Validation failures raise AIClientError — never silently
    accepted. See story_extractor.py for the privacy and error-handling contract.

    Phase 10.2.b matching uses:
      domain               — semantic domain alignment against JD classification
      tags                 — tag-based pre-filtering (Postgres text[] @> operator)
      numbers              — stories with concrete metrics weighted higher
      extraction_timestamp — batch identification for current-batch queries
    """

    title: str = Field(
        min_length=1,
        max_length=200,
        description="Short label for the story — e.g. 'Scheduling system rebuild'",
    )
    domain: str = Field(
        min_length=1,
        max_length=100,
        description="Professional domain — e.g. 'operations management', 'software engineering'",
    )
    year: Optional[int] = Field(
        default=None,
        ge=1950,
        le=2030,
        description="Calendar year of the achievement; null if undated or pre-professional",
    )
    one_line: str = Field(
        min_length=10,
        max_length=300,
        description="Single sentence summarising the achievement and its outcome",
    )
    detailed: str = Field(
        min_length=20,
        max_length=2000,
        description="100–200 word narrative suitable as a cover letter body paragraph",
    )
    numbers: list[StoryNumber] = Field(
        default_factory=list,
        description=(
            "Concrete, explicitly stated quantities from the achievement. "
            "Empty list if no measurable metric appears in the source CV. "
            "Never contains fabricated or estimated values."
        ),
    )
    tags: list[str] = Field(
        default_factory=list,
        max_length=10,
        description=(
            "Category labels from the advisory vocabulary: leadership, technical, "
            "client_facing, crisis_management, growth, process_improvement, "
            "delivery, culture. Not enforced as enum — extensible for Phase 10.2.b."
        ),
    )
    extraction_timestamp: datetime = Field(
        description=(
            "Timestamp set by cv-backend. Identical across all stories in a single "
            "extraction batch. Enables batch-identification queries in Phase 10.2.b: "
            "WHERE user_id = ? AND extraction_timestamp = MAX(extraction_timestamp). "
            "Typed as datetime so Pydantic validates it is a real timestamp, not an "
            "arbitrary string. FastAPI serialises it to ISO 8601 in HTTP responses."
        ),
    )
    id: Optional[str] = Field(
        default=None,
        description=(
            "DB UUID — present when Story is read back from the stories table "
            "(Phase 10.2.b match endpoint). Always None during extraction: cv-backend "
            "never sets it; the DB generates it via gen_random_uuid()."
        ),
    )


class ExtractStoriesResponse(BaseModel):
    """
    Response returned by extract_stories() and /internal/extract-stories.

    stories:    Validated list of Story objects (may be empty).
    diagnostic: Non-null when stories is empty — short explanation of why
                no achievements were found (e.g. "CV contains job descriptions
                but no distinct achievements with measurable outcomes.").
                Null when stories is non-empty.
    """

    stories: list[Story]
    diagnostic: Optional[str] = None


# ── Phase 10.2.b — matching schemas ──────────────────────────────────────────


class MatchStoriesRequest(BaseModel):
    """
    Request body for POST /internal/match-stories.

    jd_text : Full job description text (used for keyword tokenisation).
    stories : DB story rows for the user's current batch. Each Story must
              have its `id` field populated (UUID from the stories table).
              The match endpoint returns scored ids; the caller merges them
              back onto the full story rows using those ids.
    """

    jd_text: str = Field(min_length=1, description="Job description text to match against")
    stories: list[Story] = Field(
        description="Current story batch — must have id set on each Story"
    )


class ScoredStory(BaseModel):
    """A single story's relevance score, keyed by DB UUID."""

    story_id: str
    score: float = Field(ge=0.0, le=1.0)


class MatchStoriesResponse(BaseModel):
    """
    Response from POST /internal/match-stories.

    scored: Stories ranked by relevance_score descending.
            The caller merges scores back onto full story objects by story_id.
    """

    scored: list[ScoredStory]
