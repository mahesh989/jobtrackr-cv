"""CV structurizer — one comprehensive parse at upload time.

Turns raw extracted CV text into a normalised structured object:

    {contact, summary, experience[], education[], certifications[],
     skills{}, references[], gaps[]}

This is the analysis source of truth. The AI does the faithful extraction
(dates verbatim, never inferred — same philosophy as honesty_guard) and
returns categorised skills in the same response (single AI call).

A deterministic pass then:
  • normalises/coerces the shape so the review form always gets valid data,
  • applies the bucketing rule (care-sector VET quals → education,
    everything else stays where the AI placed it),
  • computes `gaps` — the missing/incomplete fields the form surfaces as
    amber, non-blocking warnings.
"""
from __future__ import annotations

import logging
import re
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
) -> Dict[str, Any]:
    """Parse `cv_text` into the structured CV object — including skills — in
    a single AI call.

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
    return normalise_structured_cv(raw)


def normalise_structured_cv(raw: Any) -> Dict[str, Any]:
    """Coerce the AI response into the canonical structured-CV shape, apply
    the care-VET → education bucketing rule, and compute deterministic gaps.

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
    skills_obj = _normalise_skills_from_ai(raw.get("skills"))

    # Care-sector VET quals → Education (deterministic safety net). The
    # prompt asks the AI to do this, but a stricter post-processor ensures
    # the rule holds even when the AI misroutes (e.g. on a Certificate IV
    # that came in under certifications historically).
    education, certifications = _route_care_vet_to_education(education, certifications)

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


_BULLET_PREFIX_RE = re.compile(r"^[\s\-•·*]+")
_SENTENCE_END_RE  = re.compile(r"[\.!?\"'\)\]]\s*$")
_CONTINUATION_HEAD_RE = re.compile(r"^(?:and|or|but|with|to|for|by|including|such as|while|when|that|which|who|whom|whose)\b", re.IGNORECASE)


def _strip_bullet_prefix(b: Any) -> str:
    """Bullets are stored as plain text. The renderer adds the "- " marker.
    Strip any leading "•", "-", "*", "·" the AI/source may have left in so
    the UI doesn't render duplicate markers next to each bullet."""
    s = _str(b)
    return _BULLET_PREFIX_RE.sub("", s).strip() if s else ""


def _looks_like_continuation(prev: str, curr: str) -> bool:
    """True when `curr` looks like the wrapped tail of `prev` (PDF column
    overflow), not a new bullet. Heuristics:
      • prev has no terminal punctuation (`.`, `!`, `?`, `)`, `"`), OR
      • curr starts with a lowercase word, OR
      • curr starts with a known continuation word (and/or/but/with/...).
    Two opening conditions because the AI sometimes emits a single short
    word like "protocols." as its own bullet — the previous-line check
    catches that.
    """
    if not prev or not curr:
        return False
    if not _SENTENCE_END_RE.search(prev):
        return True
    # Even when `prev` ends in a period, "protocols." or "techniques" alone
    # is almost never a real bullet — fall back to the head test.
    first = curr.split(maxsplit=1)[0] if curr else ""
    if first and first[0].islower():
        return True
    if _CONTINUATION_HEAD_RE.match(curr):
        return True
    return False


def _merge_split_bullets(bullets: List[str]) -> List[str]:
    """Defensive: even after a strong prompt, AI/PDF wrapping sometimes
    yields adjacent fragments of one bullet. Walk the list and merge any
    pair where the second looks like a wrap of the first."""
    out: List[str] = []
    for b in bullets:
        if not b:
            continue
        if out and _looks_like_continuation(out[-1], b):
            out[-1] = (out[-1].rstrip() + " " + b.lstrip()).strip()
        else:
            out.append(b)
    return out


def _normalise_experience(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    bullets = raw.get("bullets")
    cleaned: List[str] = []
    if isinstance(bullets, list):
        cleaned = [_strip_bullet_prefix(b) for b in bullets if _strip_bullet_prefix(b)]
        cleaned = _merge_split_bullets(cleaned)
    return {
        "employer":    _str(raw.get("employer")),
        "role":        _str(raw.get("role")),
        "location":    _str(raw.get("location")),
        "start_date":  _str(raw.get("start_date")),
        "end_date":    _str(raw.get("end_date")),
        "is_current":  bool(raw.get("is_current")),
        "bullets":     cleaned,
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
        # Carried through when the post-processor moved an item out of
        # certifications; the UI surfaces an "moved from certifications"
        # badge so the user understands the rebucketing.
        "_moved_from_certifications": bool(raw.get("_moved_from_certifications")),
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


def _normalise_skills_from_ai(skills: Any) -> Dict[str, List[str]]:
    """Coerce the AI-returned skills block. De-dupe within each bucket,
    lowercase, drop blanks. Never raises."""
    skills = skills if isinstance(skills, dict) else {}
    out: Dict[str, List[str]] = {}
    for key in ("technical", "soft_skills", "domain_knowledge"):
        v = skills.get(key)
        cleaned: List[str] = []
        seen: set[str] = set()
        if isinstance(v, list):
            for x in v:
                s = _str(x).lower()
                if s and s not in seen:
                    cleaned.append(s)
                    seen.add(s)
        out[key] = cleaned
    return out


# ---------------------------------------------------------------------------
# Bucketing rule: care-sector VET qualifications → Education
# ---------------------------------------------------------------------------

# Care/health VET qualifications belong with the candidate's main
# academic credentials, not the licence/short-course pile. Match the
# qualification NAME (not the issuer): "Certificate IV in Ageing Support",
# "Certificate III in Individual Support", "Diploma of Community Services",
# etc. Match is case-insensitive substring on a normalised name.
_CARE_VET_PATTERNS = re.compile(
    r"(?ix)\b"
    r"(?:certificate\s+(?:iii|iv|3|4)|diploma|advanced\s+diploma)\b"
    r".*?\b(?:"
    r"ageing\s+support|aged\s+care|individual\s+support|disability(?:\s+support)?|"
    r"community\s+services|nursing|health\s+services\s+assistance|allied\s+health"
    r")\b"
)


def _looks_like_care_vet(cert_name: str) -> bool:
    return bool(_CARE_VET_PATTERNS.search(cert_name or ""))


def _route_care_vet_to_education(
    education: List[Dict[str, Any]],
    certifications: List[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Move any care-sector VET quals from certifications into education.

    A certifications entry is moved when its `name` matches the care-VET
    pattern. The translation maps certification fields → education fields:
        name        → qualification
        issuer      → institution
        issued_date → end_date    (with completed=True)
    """
    if not certifications:
        return education, certifications

    new_education = list(education)
    remaining_certs: List[Dict[str, Any]] = []
    for c in certifications:
        if _looks_like_care_vet(c.get("name", "")):
            new_education.append({
                "institution":   c.get("issuer", ""),
                "qualification": c.get("name", ""),
                "location":      "",
                "start_date":    "",
                "end_date":      c.get("issued_date", ""),
                "completed":     True,
                "_moved_from_certifications": True,
            })
        else:
            remaining_certs.append(c)
    return new_education, remaining_certs


# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------

def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _as_list(v: Any) -> List[Any]:
    return v if isinstance(v, list) else []


def _gap(section: str, entry_index: str, field: str, message: str) -> Dict[str, str]:
    return {"section": section, "entry_index": entry_index, "field": field, "message": message}
