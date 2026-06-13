"""Pydantic schema for the voice fingerprint — 14-key structured output.

Shared across Phase 1 (fingerprint extraction) and Phase 4 (Pass 2 voice
transfer). Import path: app.schemas.voice.VoiceFingerprint
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class VoiceFingerprint(BaseModel):
    """
    Structured voice fingerprint extracted from a writing sample.

    All 14 fields are required. The extraction service validates the raw
    model response against this schema; any validation failure raises
    AIClientError with both the validation error and the raw output.
    """

    avg_sentence_length: float = Field(
        gt=0, description="Mean word count per sentence"
    )
    sentence_length_stddev: float = Field(
        ge=0, description="Std deviation of per-sentence word counts"
    )
    uses_contractions: bool
    uses_em_dashes: bool
    uses_semicolons: bool
    uses_parentheticals: bool
    formality_score: float = Field(
        ge=0.0, le=1.0, description="0.0 = extremely casual, 1.0 = extremely formal"
    )
    vocabulary_complexity: Literal["simple", "moderate", "elevated"]
    avg_syllables_per_word: float = Field(gt=0)
    paragraph_opener_patterns: list[str] = Field(
        min_length=1,
        description="Actual words/phrases used to open paragraphs or sentences",
    )
    intensifier_words: list[str] = Field(
        description="Words this writer uses for emphasis (e.g. 'quite', 'genuinely')"
    )
    sentence_starter_variety: float = Field(
        ge=0.0, le=1.0, description="Unique sentence-opening words / total sentences"
    )
    rhetorical_devices: list[str] = Field(
        description="Specific devices observed, e.g. 'short fragment for emphasis'. "
        "Empty list if none present."
    )
    tells: list[str] = Field(
        min_length=3,
        max_length=5,
        description="3–5 specific, mimicable quirks. Must be concrete enough for a "
        "skilled writer to replicate deliberately.",
    )
