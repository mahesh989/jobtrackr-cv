"""Step 1 — JD analysis. Calls AI to extract structured insight from JD text.

Output schema (nested, used by every downstream step):

    {
      "job_title": str,
      "seniority_level": str,
      "summary": str,
      "responsibilities": [str, ...],
      "experience_years_required": Optional[int],
      "required_skills":  {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]},
      "preferred_skills": {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}
    }
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    JD_ANALYSIS_SYSTEM,
    JD_ANALYSIS_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)


_TOP_LEVEL_KEYS = {
    "job_title",
    "seniority_level",
    "summary",
    "responsibilities",
    "required_skills",
    "preferred_skills",
}
_CATEGORY_KEYS = ("technical", "soft_skills", "domain_knowledge")


async def run_jd_analysis(client: AIClient, jd_text: str) -> Dict[str, Any]:
    if not jd_text or not jd_text.strip():
        raise ValueError("Job description text is empty")

    user_prompt = JD_ANALYSIS_USER_TEMPLATE.format(jd_text=jd_text)
    result = await client.complete_json(
        system=JD_ANALYSIS_SYSTEM, user=user_prompt, max_tokens=2048, temperature=0.1
    )

    missing = _TOP_LEVEL_KEYS - set(result.keys())
    if missing:
        raise ValueError(
            f"JD analysis response missing required keys: {sorted(missing)}"
        )

    # Normalise required / preferred to the canonical nested shape.
    result["required_skills"] = _normalise_skill_block(
        result.get("required_skills"), block_name="required_skills"
    )
    result["preferred_skills"] = _normalise_skill_block(
        result.get("preferred_skills"), block_name="preferred_skills"
    )

    # responsibilities → list of trimmed strings
    result["responsibilities"] = [
        str(r).strip()
        for r in (result.get("responsibilities") or [])
        if str(r).strip()
    ]

    # experience_years_required → int or None
    result["experience_years_required"] = _coerce_int_or_none(
        result.get("experience_years_required")
    )

    # Drop obsolete top-level domain_keywords if the model returned it,
    # so downstream consumers do not key into a non-canonical field.
    result.pop("domain_keywords", None)

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalise_skill_block(value: Any, *, block_name: str) -> Dict[str, List[str]]:
    """
    Coerce a required_skills / preferred_skills block to:
        {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}

    Tolerates the legacy flat-list shape by funnelling unknown items into
    "technical", but logs a warning so we can spot models that ignored
    the schema.
    """
    if isinstance(value, list):
        logger.warning(
            "JD analysis returned %s as a flat list; coercing into 'technical'.",
            block_name,
        )
        return {
            "technical": _normalise_keyword_list(value),
            "soft_skills": [],
            "domain_knowledge": [],
        }

    if not isinstance(value, dict):
        raise ValueError(
            f"JD analysis: '{block_name}' must be an object with categories, got {type(value).__name__}"
        )

    out: Dict[str, List[str]] = {}
    for cat in _CATEGORY_KEYS:
        out[cat] = _normalise_keyword_list(value.get(cat))
    return out


def _normalise_keyword_list(items: Any) -> List[str]:
    """Lowercase, strip, and de-duplicate a list of keyword strings."""
    if not items:
        return []
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


def _coerce_int_or_none(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None
