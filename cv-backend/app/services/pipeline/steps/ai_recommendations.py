"""Step 5 — AI Recommendations. Generates a Markdown advice document."""
from __future__ import annotations

import json
import logging
from typing import Any, Dict

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    AI_RECOMMENDATIONS_SYSTEM,
    AI_RECOMMENDATIONS_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)


_REQUIRED_HEADINGS = (
    "## Will Be Applied to Your CV",
    "## Honest Gaps",
    "## Format and Structure",
    "## Final Tailored Summary",
)
_MIN_LENGTH = 400


async def run_ai_recommendations(
    client: AIClient,
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    input_recs: Dict[str, Any],
    feasibility: Dict[str, Any],
) -> str:
    user_prompt = AI_RECOMMENDATIONS_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(jd_analysis, indent=2),
        matching_json=json.dumps(matching, indent=2),
        input_recs_json=json.dumps(input_recs, indent=2),
        feasibility_json=json.dumps(feasibility, indent=2),
    )
    markdown = await client.complete(
        system=AI_RECOMMENDATIONS_SYSTEM,
        user=user_prompt,
        max_tokens=3000,
        temperature=0.4,
    )

    _validate_recommendation_markdown(markdown)
    return markdown.strip()


def _validate_recommendation_markdown(md: str) -> None:
    if not md or not md.strip():
        raise ValueError("AI recommendations: empty response")
    if len(md.strip()) < _MIN_LENGTH:
        raise ValueError(
            f"AI recommendations too short ({len(md.strip())} chars, need {_MIN_LENGTH}+)"
        )
    missing = [h for h in _REQUIRED_HEADINGS if h not in md]
    if missing:
        raise ValueError(
            f"AI recommendations missing required sections: {missing}"
        )
