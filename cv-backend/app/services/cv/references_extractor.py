"""
CV references extractor — on-demand.

Reads the original CV text and asks the AI to return a JSON list of up to
3 referees with {name, job_title, company, email}. Used by the web UI to
pre-fill the user's References section under /dashboard/cv.

NEVER auto-writes to user_preferences — the result is cached on
cv_versions.extracted_references and the user clicks "Use these" to
explicitly copy them into their saved settings.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List

from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts import (
    CV_REFERENCES_EXTRACTION_SYSTEM,
    CV_REFERENCES_EXTRACTION_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)

_MAX_CV_CHARS = 24_000
_MAX_REFEREES = 3
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_FIELDS = ("name", "job_title", "company", "email")


async def extract_cv_references(client: AIClient, cv_text: str) -> List[Dict[str, str]]:
    """
    Call the AI to extract referees from the CV.

    Returns a list of up to 3 referee dicts. May return an empty list — that
    means the AI ran successfully but found no referees in the CV (legitimate
    outcome for "References available on request" CVs).

    Raises AIClientError on AI / parsing failure. Callers should treat that
    as "extraction failed" and surface a user-facing error.
    """
    if not cv_text or not cv_text.strip():
        raise ValueError("CV text is empty — cannot extract references.")

    truncated = cv_text[:_MAX_CV_CHARS]
    user_prompt = CV_REFERENCES_EXTRACTION_USER_TEMPLATE.format(cv_text=truncated)

    raw = await client.complete_json(
        system=CV_REFERENCES_EXTRACTION_SYSTEM,
        user=user_prompt,
        max_tokens=1024,
        temperature=0.0,
    )

    return _normalise(raw)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalise(raw: Any) -> List[Dict[str, str]]:
    """Coerce the AI response to a List[Dict[name|job_title|company|email]]."""
    if not isinstance(raw, dict):
        raise AIClientError(
            f"CV references extraction expected a JSON object, got {type(raw).__name__}"
        )
    referees = raw.get("referees")
    if not isinstance(referees, list):
        return []

    out: List[Dict[str, str]] = []
    for item in referees[:_MAX_REFEREES]:
        if not isinstance(item, dict):
            continue
        ref: Dict[str, str] = {}
        for f in _FIELDS:
            v = item.get(f)
            ref[f] = v.strip() if isinstance(v, str) else ""
        # Email validation — keep blank if the model returned junk
        if ref["email"] and not _EMAIL_RE.match(ref["email"]):
            ref["email"] = ""
        # Skip wholly-empty entries (model returned a stub)
        if any(ref[f] for f in _FIELDS):
            out.append(ref)
    return out
