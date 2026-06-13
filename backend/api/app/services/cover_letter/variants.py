"""
Opening paragraph variants service — Phase 11.

Single AI call returns 3-4 structurally distinct P1 openers as a validated
list of OpeningVariant objects. Used by the synchronous
/internal/generate-opening-variants endpoint.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.schemas.cover_letter import GenerateOpeningVariantsRequest, OpeningVariant
from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts.cover_letter.generate import format_story
from app.services.ai.prompts.cover_letter.opening_variants import (
    VARIANTS_SYSTEM,
    VARIANTS_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)

# 4 variants × ~60 words × ~1.5 tokens/word + JSON overhead
_VARIANTS_MAX_TOKENS = 700

# Caps consistent with the main generator
_CV_TEXT_CAP = 8000
_JD_TEXT_CAP = 1500


def _variants_temperature(model: str) -> float:
    """
    OpenAI silently forces temperature=1.0 on the gpt-5* family; match that
    rather than triggering a 400 error. Use 0.9 for all other models —
    higher than the body-generation default of 0.7 to maximise structural
    diversity across the four patterns.
    """
    if model.lower().startswith("gpt-5"):
        return 1.0
    return 0.9


async def generate_opening_variants(
    client: AIClient,
    payload: GenerateOpeningVariantsRequest,
) -> List[OpeningVariant]:
    """
    Return 3-4 structurally distinct P1 openers from a single AI call.

    Raises AIClientError if the call fails or the response cannot be parsed
    into at least 3 valid variants (each must have non-empty id, text, and
    pattern_label).
    """
    primary_story_block = format_story(payload.story)

    user = VARIANTS_USER_TEMPLATE.format(
        voice_sample=payload.voice_sample_text,
        cv_text=payload.cv_text[:_CV_TEXT_CAP],
        primary_story=primary_story_block,
        role=payload.role,
        company_name=payload.company_name,
        company_fact=payload.company_hook_text,
        jd_priorities=payload.jd_text[:_JD_TEXT_CAP],
    )

    raw: Dict[str, Any] = await client.complete_json(
        system=VARIANTS_SYSTEM,
        user=user,
        max_tokens=_VARIANTS_MAX_TOKENS,
        temperature=_variants_temperature(client.model),
        no_training=True,
    )

    raw_variants = raw.get("variants")
    if not isinstance(raw_variants, list):
        raise AIClientError(
            f"Opening variants response missing 'variants' array. "
            f"Got keys: {list(raw.keys())}"
        )

    validated: List[OpeningVariant] = []
    for item in raw_variants:
        if not isinstance(item, dict):
            continue
        id_ = str(item.get("id", "")).strip()
        text = str(item.get("text", "")).strip()
        label = str(item.get("pattern_label", "")).strip()
        if id_ and text and label:
            validated.append(OpeningVariant(id=id_, text=text, pattern_label=label))

    if len(validated) < 3:
        raise AIClientError(
            f"Only {len(validated)} of {len(raw_variants)} raw variants passed "
            f"validation — each must have non-empty id, text, and pattern_label. "
            f"Need at least 3."
        )

    logger.info(
        "opening-variants: %d variants (model=%s provider=%s)",
        len(validated),
        client.model,
        client.provider,
    )
    return validated
