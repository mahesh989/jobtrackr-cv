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

Phase 3 — Validator path (default):
    1. retrieve_skill_candidates() scans the cleaned JD text against the lexicon.
    2. If >= VALIDATOR_MIN_CANDIDATES hits, the LLM receives the candidates and
       validates presence rather than extracting from a blank slate.  This reduces
       hallucination and sharpens evidence grounding.
    3. If candidates < threshold (novel / niche JD), falls back to the original
       extraction prompt — behaviour identical to Phases 0-2.

The output contract is unchanged in both paths.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    JD_ANALYSIS_USER_TEMPLATE,
    JD_ANALYSIS_VALIDATOR_USER_TEMPLATE,
    build_jd_analysis_system_prompt,
    build_jd_analysis_validator_prompt,
)
from app.services.skills.retrieval import retrieve_skill_candidates

logger = logging.getLogger(__name__)

# Minimum lexicon candidates needed to engage the validator path.
# Below this the JD is too novel / niche for lexicon retrieval to help.
VALIDATOR_MIN_CANDIDATES = 5

_TOP_LEVEL_KEYS = {
    "job_title",
    "seniority_level",
    "summary",
    "responsibilities",
    "required_skills",
    "preferred_skills",
}
from app.enums import CATEGORY_KEYS as _CATEGORY_KEYS  # noqa: E402 — canonical source


async def run_jd_analysis(
    client: AIClient, jd_text: str, *, vertical: Optional[str] = None
) -> Dict[str, Any]:
    if not jd_text or not jd_text.strip():
        raise ValueError("Job description text is empty")

    candidates = retrieve_skill_candidates(jd_text, vertical)

    if len(candidates) >= VALIDATOR_MIN_CANDIDATES:
        logger.debug(
            "JD analysis — validator path (%d candidates, vertical=%s)",
            len(candidates), vertical,
        )
        result = await _run_validator(client, jd_text, candidates, vertical)
    else:
        logger.debug(
            "JD analysis — extraction fallback (%d candidates < %d, vertical=%s)",
            len(candidates), VALIDATOR_MIN_CANDIDATES, vertical,
        )
        result = await _run_extraction(client, jd_text, vertical)

    missing = _TOP_LEVEL_KEYS - set(result.keys())
    if missing:
        raise ValueError(
            f"JD analysis response missing required keys: {sorted(missing)}"
        )

    # Normalise required / preferred to the canonical nested shape. The
    # evidence-grounding prompt asks the LLM for [{"skill","evidence"}, ...].
    # We flatten skills back to plain string lists (downstream contract is
    # unchanged) and emit a parallel `skill_evidence` dict — lowercased skill
    # → verbatim JD quote — used by the groundedness gate in post_process.
    evidence: Dict[str, str] = {}
    result["required_skills"] = _normalise_skill_block(
        result.get("required_skills"), block_name="required_skills",
        evidence_out=evidence,
    )
    result["preferred_skills"] = _normalise_skill_block(
        result.get("preferred_skills"), block_name="preferred_skills",
        evidence_out=evidence,
    )
    result["skill_evidence"] = evidence

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

    # Drop obsolete top-level domain_keywords if the model returned it.
    result.pop("domain_keywords", None)

    return result


# ---------------------------------------------------------------------------
# Validator path (Phase 3)
# ---------------------------------------------------------------------------


async def _run_validator(
    client: AIClient,
    jd_text: str,
    candidates: List[Dict[str, str]],
    vertical: Optional[str],
) -> Dict[str, Any]:
    """Send candidates + JD to the validator LLM; normalise output to the
    standard required_skills / preferred_skills extraction schema."""
    system_prompt = build_jd_analysis_validator_prompt(vertical)
    candidates_json = json.dumps(candidates, ensure_ascii=False)
    user_prompt = JD_ANALYSIS_VALIDATOR_USER_TEMPLATE.format(
        candidates_json=candidates_json,
        jd_text=jd_text,
    )
    raw = await client.complete_json(
        system=system_prompt, user=user_prompt, max_tokens=2048, temperature=0.1
    )
    return _normalise_validator_output(raw)


def _normalise_validator_output(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Convert validator LLM output to the canonical extraction schema.

    Validator returns:
        {job_title, seniority_level, summary, responsibilities,
         experience_years_required,
         accepted: [{skill, category, requirement_level, evidence}],
         rejected: [str],
         new_discoveries: [{skill, category, requirement_level, evidence}]}

    This function merges accepted + new_discoveries into required_skills /
    preferred_skills dicts (same nested shape as the extraction path).
    """
    out: Dict[str, Any] = {
        "job_title": raw.get("job_title", ""),
        "seniority_level": raw.get("seniority_level", "unknown"),
        "summary": raw.get("summary", ""),
        "responsibilities": raw.get("responsibilities") or [],
        "experience_years_required": raw.get("experience_years_required"),
    }

    required: Dict[str, List[Any]] = {k: [] for k in _CATEGORY_KEYS}
    preferred: Dict[str, List[Any]] = {k: [] for k in _CATEGORY_KEYS}

    all_items = list(raw.get("accepted") or []) + list(raw.get("new_discoveries") or [])
    for item in all_items:
        if not isinstance(item, dict):
            continue
        skill = str(item.get("skill") or "").strip()
        cat = str(item.get("category") or "").strip()
        level = str(item.get("requirement_level") or "").strip().lower()
        evidence = str(item.get("evidence") or "").strip()
        if not skill or cat not in _CATEGORY_KEYS:
            continue
        target = required if level == "required" else preferred
        target[cat].append({"skill": skill, "evidence": evidence})

    out["required_skills"] = required
    out["preferred_skills"] = preferred
    return out


# ---------------------------------------------------------------------------
# Extraction path (fallback — original Phase 0-2 behaviour)
# ---------------------------------------------------------------------------


async def _run_extraction(
    client: AIClient,
    jd_text: str,
    vertical: Optional[str],
) -> Dict[str, Any]:
    system_prompt = build_jd_analysis_system_prompt(vertical)
    user_prompt = JD_ANALYSIS_USER_TEMPLATE.format(jd_text=jd_text)
    return await client.complete_json(
        system=system_prompt, user=user_prompt, max_tokens=2048, temperature=0.1
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalise_skill_block(
    value: Any, *, block_name: str, evidence_out: Optional[Dict[str, str]] = None,
) -> Dict[str, List[str]]:
    """
    Coerce a required_skills / preferred_skills block to:
        {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}

    Tolerates the legacy flat-list shape by funnelling unknown items into
    "technical", but logs a warning so we can spot models that ignored
    the schema.

    Each item may be either a bare string (legacy) or an object
    ``{"skill": str, "evidence": str}`` (current schema). When the object
    form is present, the evidence quote is recorded in ``evidence_out``
    keyed by the lowercased skill string.
    """
    if isinstance(value, list):
        logger.warning(
            "JD analysis returned %s as a flat list; coercing into 'technical'.",
            block_name,
        )
        return {
            "technical": _normalise_keyword_list(value, evidence_out=evidence_out),
            "soft_skills": [],
            "domain_knowledge": [],
        }

    if not isinstance(value, dict):
        raise ValueError(
            f"JD analysis: '{block_name}' must be an object with categories, got {type(value).__name__}"
        )

    out: Dict[str, List[str]] = {}
    for cat in _CATEGORY_KEYS:
        out[cat] = _normalise_keyword_list(value.get(cat), evidence_out=evidence_out)
    return out


def _normalise_keyword_list(
    items: Any, *, evidence_out: Optional[Dict[str, str]] = None,
) -> List[str]:
    """Lowercase, strip, and de-duplicate a list of skill items.

    Items may be either bare strings (legacy) or
    ``{"skill": str, "evidence": str}`` objects (current schema). When an
    item is an object and ``evidence_out`` is provided, the evidence quote
    is recorded keyed by the lowercased skill string. The first non-empty
    evidence for a given skill wins (later duplicates are ignored).
    """
    if not items:
        return []
    if not isinstance(items, list):
        return []
    seen: set[str] = set()
    out: List[str] = []
    for raw in items:
        skill_str: str
        evidence_str: str = ""
        if isinstance(raw, dict):
            skill_str = str(raw.get("skill") or "").strip()
            evidence_str = str(raw.get("evidence") or "").strip()
        else:
            skill_str = str(raw).strip()
        s = skill_str.lower()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
            if evidence_out is not None and evidence_str and s not in evidence_out:
                evidence_out[s] = evidence_str
    return out


def _coerce_int_or_none(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None
