"""CV structurizer — one comprehensive parse at upload time.

Turns raw extracted CV text into a normalised structured object:

    {contact, summary, experience[], education[], certifications[],
     skills{}, references[], gaps[]}

This is the analysis source of truth (Phase 3). The AI does the faithful
extraction (dates verbatim, never inferred — same philosophy as
honesty_guard); a deterministic pass then:
  • normalises/coerces the shape so the review form always gets valid data,
  • tags each experience entry with a vertical_hint via the same lexicon
    classifier used everywhere else (one source of truth),
  • computes `gaps` — the missing/incomplete fields the form surfaces as
    amber, non-blocking warnings.

Skills are merged in from the existing skill categoriser output so we keep
one canonical skills representation; the caller passes them in.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts import (
    CV_STRUCTURIZATION_SYSTEM,
    CV_STRUCTURIZATION_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)

_MAX_CV_CHARS = 24_000


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def structurize_cv(
    client: AIClient,
    cv_text: str,
    *,
    skills: Optional[Dict[str, List[str]]] = None,
) -> Dict[str, Any]:
    """Parse `cv_text` into the structured CV object.

    `skills` (the categorised_skills dict already computed at upload) is
    merged in verbatim so the structured CV carries one canonical skills
    representation. Pass None to leave skills empty.

    Raises AIClientError on AI/parse failure — caller treats as "structurize
    failed" and can fall back to leaving structured_cv NULL.
    """
    if not cv_text or not cv_text.strip():
        raise ValueError("CV text is empty — cannot structurize.")

    truncated = cv_text[:_MAX_CV_CHARS]
    raw = await client.complete_json(
        system=CV_STRUCTURIZATION_SYSTEM,
        user=CV_STRUCTURIZATION_USER_TEMPLATE.format(cv_text=truncated),
        max_tokens=4096,
        temperature=0.0,
    )
    return normalise_structured_cv(raw, skills=skills)


def normalise_structured_cv(
    raw: Any,
    *,
    skills: Optional[Dict[str, List[str]]] = None,
) -> Dict[str, Any]:
    """Coerce the AI response into the canonical structured-CV shape, tag
    experience verticals, merge skills, and compute deterministic gaps.

    Pure + defensive: tolerates a malformed AI response by returning a
    well-formed object with whatever could be salvaged (never raises)."""
    if not isinstance(raw, dict):
        raw = {}

    contact = _normalise_contact(raw.get("contact"))
    summary = _str(raw.get("summary"))
    experience = [_normalise_experience(e) for e in _as_list(raw.get("experience"))]
    education = [_normalise_education(e) for e in _as_list(raw.get("education"))]
    certifications = [_normalise_cert(c) for c in _as_list(raw.get("certifications"))]
    references = [_normalise_referee(r) for r in _as_list(raw.get("references"))]

    # Tag each experience entry with its lexicon vertical so the tailoring
    # selection (Phase 4) can rank by JD relevance without re-deriving it.
    for e in experience:
        e["vertical_hint"] = _classify_entry_vertical(e)

    skills_obj = _normalise_skills(skills)

    structured = {
        "contact":        contact,
        "summary":        summary,
        "experience":     experience,
        "education":      education,
        "certifications": certifications,
        "skills":         skills_obj,
        "references":     references,
    }
    structured["gaps"] = detect_gaps(structured)
    return structured


# ---------------------------------------------------------------------------
# Gap detection (deterministic, non-blocking)
# ---------------------------------------------------------------------------

def detect_gaps(structured: Dict[str, Any]) -> List[Dict[str, str]]:
    """Return a list of missing/incomplete fields for the review form to flag.

    Each gap: {section, entry_index, field, message}. entry_index is "" for
    section-level gaps. These are advisory (the user may skip them) — they do
    not block analysis.
    """
    gaps: List[Dict[str, str]] = []

    contact = structured.get("contact") or {}
    if not contact.get("email"):
        gaps.append(_gap("contact", "", "email", "No contact email found — add one so employers can reach you."))
    if not contact.get("name"):
        gaps.append(_gap("contact", "", "name", "No name detected on the CV."))

    if not _str(structured.get("summary")):
        gaps.append(_gap("summary", "", "summary", "No professional summary — a 2–3 line summary strengthens the CV."))

    experience = structured.get("experience") or []
    if not experience:
        gaps.append(_gap("experience", "", "", "No work experience detected."))
    for i, e in enumerate(experience):
        if not e.get("start_date") and not e.get("end_date"):
            gaps.append(_gap("experience", str(i), "dates",
                             f"{e.get('employer') or 'A role'} has no dates — add them or leave blank if intentional."))
        if not e.get("bullets"):
            gaps.append(_gap("experience", str(i), "bullets",
                             f"{e.get('employer') or 'A role'} has no description bullets."))

    education = structured.get("education") or []
    for i, ed in enumerate(education):
        if not ed.get("start_date") and not ed.get("end_date"):
            gaps.append(_gap("education", str(i), "dates",
                             f"{ed.get('qualification') or 'An education entry'} has no date — add the year."))

    return gaps


# ---------------------------------------------------------------------------
# Normalisers
# ---------------------------------------------------------------------------

def _normalise_contact(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    links = raw.get("links")
    return {
        "name":     _str(raw.get("name")),
        "email":    _str(raw.get("email")),
        "phone":    _str(raw.get("phone")),
        "location": _str(raw.get("location")),
        "links":    [_str(x) for x in links if _str(x)] if isinstance(links, list) else [],
    }


def _normalise_experience(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    bullets = raw.get("bullets")
    return {
        "employer":    _str(raw.get("employer")),
        "role":        _str(raw.get("role")),
        "location":    _str(raw.get("location")),
        "start_date":  _str(raw.get("start_date")),
        "end_date":    _str(raw.get("end_date")),
        "is_current":  bool(raw.get("is_current")),
        "bullets":     [_str(b) for b in bullets if _str(b)] if isinstance(bullets, list) else [],
    }


def _normalise_education(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "institution":   _str(raw.get("institution")),
        "qualification": _str(raw.get("qualification")),
        "location":      _str(raw.get("location")),
        "start_date":    _str(raw.get("start_date")),
        "end_date":      _str(raw.get("end_date")),
        "completed":     bool(raw.get("completed")),
    }


def _normalise_cert(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "name":        _str(raw.get("name")),
        "issuer":      _str(raw.get("issuer")),
        "code":        _str(raw.get("code")),
        "issued_date": _str(raw.get("issued_date")),
    }


def _normalise_referee(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "name":      _str(raw.get("name")),
        "job_title": _str(raw.get("job_title")),
        "company":   _str(raw.get("company")),
        "email":     _str(raw.get("email")),
    }


def _normalise_skills(skills: Optional[Dict[str, List[str]]]) -> Dict[str, List[str]]:
    skills = skills if isinstance(skills, dict) else {}
    out: Dict[str, List[str]] = {}
    for key in ("technical", "soft_skills", "domain_knowledge"):
        v = skills.get(key)
        out[key] = [_str(x) for x in v if _str(x)] if isinstance(v, list) else []
    return out


# ---------------------------------------------------------------------------
# Vertical tagging — reuse the shared lexicon classifier (one source of truth)
# ---------------------------------------------------------------------------

def _classify_entry_vertical(entry: Dict[str, Any]) -> str:
    """Best-effort vertical for an experience entry. Reuses the experience
    parser's per-vertical hit counter (the same lexicon `classify()` used by
    JD analysis + skill categorisation — one source of truth). Returns the
    winning vertical name, or "other" when nothing resolves."""
    try:
        from app.services.cv.experience_parser import _classify_entry_verticals
    except Exception:  # pragma: no cover - import guard
        return "other"

    try:
        hits = _classify_entry_verticals(entry.get("role") or "", entry.get("bullets") or [])
    except Exception:  # noqa: BLE001 — tagging must never abort structurization
        return "other"

    best, best_n = "other", 0
    for vert, n in (hits or {}).items():
        if n > best_n:
            best, best_n = vert, n
    return best


# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------

def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _as_list(v: Any) -> List[Any]:
    return v if isinstance(v, list) else []


def _gap(section: str, entry_index: str, field: str, message: str) -> Dict[str, str]:
    return {"section": section, "entry_index": entry_index, "field": field, "message": message}
