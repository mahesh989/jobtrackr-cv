"""
One-time CV skill categorisation.

Runs at CV upload (or via backfill) — extracts every skill the CV
demonstrates and buckets it into technical / soft_skills /
domain_knowledge. Cached on `cv_versions.categorised_skills` so the
analysis page can render it without recomputing per run.

Output schema (always — even if AI returns garbage we coerce to this):

    {
      "technical":        [str, ...],
      "soft_skills":      [str, ...],
      "domain_knowledge": [str, ...]
    }
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts import (
    CV_SKILL_CATEGORISATION_SYSTEM,
    CV_SKILL_CATEGORISATION_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)

CATEGORY_KEYS = ("technical", "soft_skills", "domain_knowledge")

# Hard ceiling on CV text we send to the model — the prompt is the cheap
# part, but extremely long CVs blow the token budget for no benefit.
_MAX_CV_CHARS = 24_000


async def categorise_cv_skills(client: AIClient, cv_text: str) -> Dict[str, List[str]]:
    """
    Call the AI client to categorise the skills in `cv_text`.

    Returns a dict with all three category keys present (lists may be
    empty). Raises AIClientError on AI / parsing failure — callers should
    handle that and persist null if categorisation is non-essential.
    """
    if not cv_text or not cv_text.strip():
        raise ValueError("CV text is empty — cannot categorise.")

    truncated = cv_text[:_MAX_CV_CHARS]
    user_prompt = CV_SKILL_CATEGORISATION_USER_TEMPLATE.format(cv_text=truncated)

    raw = await client.complete_json(
        system=CV_SKILL_CATEGORISATION_SYSTEM,
        user=user_prompt,
        max_tokens=1536,
        temperature=0.1,
    )

    normalised = _normalise(raw)

    # Lexicon noise filter — strip credentials, eligibility statements, and
    # framework/value noise that the LLM may have categorised as a skill.
    # This is the CV-side counterpart to the JD post-processor; both share
    # the same universal_noise list so CV and JD agree on what's a skill.
    # Vertical-specific lexicons are NOT applied here (no JD context at
    # upload time) — that happens at JD-analysis time on the matching path.
    from app.services.skills import post_process_cv_skills
    cleaned, _sidecar = post_process_cv_skills(normalised)
    return cleaned


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalise(raw: Any) -> Dict[str, List[str]]:
    """
    Coerce the AI response to the canonical {technical, soft_skills,
    domain_knowledge} shape, lowercasing and de-duping each list.
    """
    if not isinstance(raw, dict):
        raise AIClientError(
            f"CV categorisation expected a JSON object, got {type(raw).__name__}"
        )

    out: Dict[str, List[str]] = {}
    for cat in CATEGORY_KEYS:
        out[cat] = _normalise_keyword_list(raw.get(cat))
    return out


def _normalise_keyword_list(items: Any) -> List[str]:
    if not isinstance(items, list):
        return []
    seen: set[str] = set()
    out: List[str] = []
    for raw in items:
        s = str(raw).lower().strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out
