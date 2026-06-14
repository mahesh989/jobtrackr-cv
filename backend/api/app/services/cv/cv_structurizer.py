"""CV structurizer — one comprehensive parse at upload time.

Turns raw extracted CV text into a normalised structured object:

    {summary, experience[], education[], awards[], certifications[],
     skills{}, references[], gaps[]}

`skills` is a MIRROR of the categorised_skills column (populated by the
dedicated `/internal/categorise-cv` AI call) — the structurize prompt
itself does NOT extract skills. The web layer merges the categoriser's
output into `structured_cv.skills` before persisting so the review form
has a single editable view.

Contact details are NOT extracted from the CV text — they come from the
user's profile via stamp_contact_line() in the analysis renderer.

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

# Bump whenever parser logic changes — the review page's server component
# silently re-runs structurization on any CV whose stored `_version` is
# below this. Mirror in frontend/web/src/lib/cvBackend.ts.
STRUCTURED_CV_VERSION = 4


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

    summary = _str(raw.get("summary"))
    experience = [_normalise_experience(e) for e in _as_list(raw.get("experience"))]
    experience = _sort_experience_recent_first(experience)
    education = [_normalise_education(e) for e in _as_list(raw.get("education"))]
    education = _dedupe_education(education)
    awards = [_normalise_award(a) for a in _as_list(raw.get("awards"))]
    languages = [_normalise_language(l) for l in _as_list(raw.get("languages"))]
    certifications = [_normalise_cert(c) for c in _as_list(raw.get("certifications"))]
    references = [_normalise_referee(r) for r in _as_list(raw.get("references"))]
    # `skills` is a mirror of categorised_skills, written by the web layer
    # after the parallel categoriseCv call. Preserve anything the caller
    # passed in (e.g. an existing structured_cv being re-normalised on
    # PATCH); fall back to empty buckets.
    skills_obj = _normalise_skills_from_ai(raw.get("skills"))

    # Care-sector VET quals → Education (deterministic safety net). The
    # prompt asks the AI to do this, but a stricter post-processor ensures
    # the rule holds even when the AI misroutes (e.g. on a Certificate IV
    # that came in under certifications historically).
    education, certifications = _route_care_vet_to_education(education, certifications)

    structured = {
        "summary":        summary,
        "experience":     experience,
        "education":      education,
        "awards":         awards,
        "languages":      languages,
        "certifications": certifications,
        "skills":         skills_obj,
        "references":     references,
        "_version":       STRUCTURED_CV_VERSION,
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


def _normalise_award(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "name":        _str(raw.get("name")),
        "issuer":      _str(raw.get("issuer")),
        "location":    _str(raw.get("location")),
        "date":        _str(raw.get("date")),
        "description": _str(raw.get("description")),
    }


def _normalise_language(raw: Any) -> Dict[str, str]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "language":    _str(raw.get("language")),
        "proficiency": _str(raw.get("proficiency")),
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


_VET_NORMALISE_RE = re.compile(r"[^a-z0-9]+")


def _vet_qual_key(name: str) -> str:
    """Normalise a qualification name for fuzzy dedupe — lowercase, strip
    non-alphanumerics, and trim any leading AU unit code (e.g. "CHC43015 -")
    so 'CHC43015 - Certificate IV in Ageing Support' and 'Certificate IV in
    Ageing Support' compare equal."""
    s = (name or "").lower()
    s = re.sub(r"^\s*[a-z]{2,5}\d{3,7}\s*[-:]\s*", "", s)
    return _VET_NORMALISE_RE.sub("", s)


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

    Dedupe: if education already contains a fuzzy-matching qualification
    (same name modulo unit code prefix + punctuation), drop the cert instead
    of adding a second copy. The AI sometimes puts the same Cert IV in BOTH
    education and certifications.
    """
    if not certifications:
        return education, certifications

    existing_keys = {_vet_qual_key(e.get("qualification", "")) for e in education}
    new_education = list(education)
    remaining_certs: List[Dict[str, Any]] = []
    for c in certifications:
        if _looks_like_care_vet(c.get("name", "")):
            key = _vet_qual_key(c.get("name", ""))
            if key and key in existing_keys:
                # Already represented in education — drop the duplicate cert.
                continue
            existing_keys.add(key)
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
# Experience ordering + education dedupe
# ---------------------------------------------------------------------------

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def _parse_end_date(date_str: str, is_current: bool) -> tuple[int, int]:
    """Return a (year, month) tuple used as a sort key — higher = more recent.
    "Present"/is_current → (9999, 12). Unparseable → (0, 0)."""
    if is_current:
        return (9999, 12)
    s = (date_str or "").strip().lower()
    if not s:
        return (0, 0)
    if "present" in s or "current" in s or "now" in s or "ongoing" in s:
        return (9999, 12)

    # "Feb 2026", "February, 11, 2026", "Feb, 2026"
    m = re.search(r"\b([a-z]{3,9})\.?,?\s*\d{0,2},?\s*(\d{4})\b", s)
    if m and m.group(1) in _MONTHS:
        return (int(m.group(2)), _MONTHS[m.group(1)])
    # "05/2025" or "5/2025"
    m = re.search(r"\b(\d{1,2})\s*/\s*(\d{4})\b", s)
    if m:
        return (int(m.group(2)), int(m.group(1)))
    # "2025-05"
    m = re.search(r"\b(\d{4})\s*-\s*(\d{1,2})\b", s)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    # Bare year
    m = re.search(r"\b(20\d{2}|19\d{2})\b", s)
    if m:
        return (int(m.group(1)), 12)
    return (0, 0)


def _sort_experience_recent_first(experience: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Stable sort by parsed end_date descending. Entries with no parsable
    date sink to the bottom (still in their original relative order)."""
    indexed = list(enumerate(experience))
    indexed.sort(
        key=lambda pair: (
            _parse_end_date(pair[1].get("end_date", ""), bool(pair[1].get("is_current"))),
            -pair[0],  # stability inverted so earlier entries lose ties on equal dates
        ),
        reverse=True,
    )
    return [e for _, e in indexed]


def _dedupe_education(education: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fuzzy-dedupe by qualification name (modulo unit code prefix). Keeps
    the FIRST occurrence; the AI sometimes lists the same Cert IV twice."""
    seen: set[str] = set()
    out: List[Dict[str, Any]] = []
    for e in education:
        key = _vet_qual_key(e.get("qualification", ""))
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        out.append(e)
    return out


# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------

def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _as_list(v: Any) -> List[Any]:
    return v if isinstance(v, list) else []


def _gap(section: str, entry_index: str, field: str, message: str) -> Dict[str, str]:
    return {"section": section, "entry_index": entry_index, "field": field, "message": message}
