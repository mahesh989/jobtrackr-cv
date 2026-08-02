"""Prose gates — profile word count, seniority, career highlights.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
import re
from .parsing import (
    _EDUCATION_ALIASES,
    _EXPERIENCE_ALIASES,
    _PROFILE_ALIASES,
    _PROJECTS_ALIASES,
    _SKILLS_ALIASES,
    _resolve_section,
    _word_count,
)
from .results import _result

# Words the writer is allowed to use in the Profile only if they are
# literally present in the candidate's CV job titles (per the
# SENIORITY LITERAL-MATCH RULE in the prompt).
_SENIORITY_TOKENS = (
    "senior",
    "lead",
    "principal",
    "staff",
    "manager",
    "director",
)


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------


def _gate_profile_word_count(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Career Highlights = 2 sentences of prose (positioning + achievement).
    Healthy total is 35-50 words — matches the composer prompt's own
    "35-50 words total" ceiling (composition.py CAREER-STYLE SUMMARY) and the
    deterministic trimmer's max_words=50 (tailored_cv.py
    _enforce_career_highlights_words). No bullets, no skills line.
    """
    body = _resolve_section(sections, _PROFILE_ALIASES)
    if not body:
        return _result(
            "profile_word_count", "fail",
            "No ## Career Highlights section detected.",
        )
    n = _word_count(body)
    if n < 25:
        return _result(
            "profile_word_count", "fail",
            f"Career Highlights is only {n} words — far too thin.",
        )
    if n < 35:
        return _result(
            "profile_word_count", "warn",
            f"Career Highlights is only {n} words (target 35-50).",
        )
    if n > 65:
        return _result(
            "profile_word_count", "fail",
            f"Career Highlights is {n} words (hard cap 50, absolute max 65).",
        )
    if n > 50:
        return _result(
            "profile_word_count", "warn",
            f"Career Highlights is {n} words — getting padded (target 35-50).",
        )
    return _result(
        "profile_word_count", "pass",
        f"Career Highlights is {n} words.",
    )


def _gate_seniority_literal_match(
    sections: Dict[str, str], original_cv_text: str,
) -> Dict[str, Any]:
    """
    If the Profile uses a seniority token, that exact word must also
    appear somewhere in the original CV text. Otherwise it is a likely
    fabrication.

    Reported as WARN (not fail) because edge cases exist where the user
    legitimately describes themselves at one level higher in plain prose
    elsewhere; a human should make the call.
    """
    profile = _resolve_section(sections, _PROFILE_ALIASES)
    if not profile:
        return _result(
            "seniority_literal_match", "warn",
            "No Profile section to check.",
        )
    profile_lower = profile.lower()
    cv_lower = (original_cv_text or "").lower()
    flagged: List[str] = []
    for token in _SENIORITY_TOKENS:
        in_profile = re.search(rf"\b{token}\b", profile_lower) is not None
        in_cv = re.search(rf"\b{token}\b", cv_lower) is not None
        if in_profile and not in_cv:
            flagged.append(token)
    if flagged:
        return _result(
            "seniority_literal_match", "warn",
            f"Profile uses {', '.join(flagged)} but the original CV "
            "does not contain those words — verify the seniority claim.",
        )
    return _result(
        "seniority_literal_match", "pass",
        "No seniority words appear in the Profile that aren't in the CV.",
    )


def _gate_highlights_no_bullets(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Career Highlights must be prose-only — no bullet points allowed.
    The new format is exactly 2 sentences with no list markers.
    """
    body = _resolve_section(sections, _PROFILE_ALIASES)
    if not body:
        return _result(
            "highlights_no_bullets", "warn",
            "No Career Highlights section to check.",
        )

    bullet_re = re.compile(r"^\s*[-•*]\s+(.*)$")
    bullets: List[str] = []
    for raw in body.splitlines():
        m = bullet_re.match(raw)
        if m:
            bullets.append(m.group(1).strip())

    if bullets:
        return _result(
            "highlights_no_bullets", "fail",
            f"Career Highlights contains {len(bullets)} bullet point(s) — "
            "must be prose only (2 sentences, no list markers).",
        )
    return _result(
        "highlights_no_bullets", "pass",
        "Career Highlights is prose-only — no bullets detected.",
    )


def _gate_highlights_prose_shape(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Career Highlights must be exactly 2 sentences of prose.
    No skills line (*Skills: ...*) allowed.
    """
    body = _resolve_section(sections, _PROFILE_ALIASES)
    if not body:
        return _result(
            "highlights_prose_shape", "warn",
            "No Career Highlights section to check.",
        )

    issues: List[str] = []

    # Check for banned skills line
    skills_line_re = re.compile(r"^\s*\*\s*Skills\s*:", re.IGNORECASE)
    for raw in body.splitlines():
        if skills_line_re.match(raw.strip()):
            issues.append("Contains a '*Skills: ...*' line — remove it")
            break

    # Count sentences heuristically: split on period-space or period-end,
    # ignoring common abbreviations and decimal numbers.
    # Strip the skills line (if present) before counting.
    prose = body
    for raw in body.splitlines():
        stripped = raw.strip()
        if stripped.startswith("*") and "skills" in stripped.lower():
            prose = prose.replace(raw, "")

    # Sentence boundary: a period followed by a space+uppercase letter
    # or end of string. Also count ? and ! as terminators.
    # Exclude common abbreviations that contain periods.
    clean = re.sub(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|vs|etc|e\.g|i\.e)\.", "ABBR", prose)
    sentences = re.split(r'[.!?](?:\s+[A-Z]|\s*$)', clean.strip())
    # Filter out empty fragments
    sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 5]
    n_sentences = len(sentences)

    if n_sentences < 2:
        issues.append(f"Only {n_sentences} sentence(s) detected — need exactly 2")
    elif n_sentences > 2:
        issues.append(f"{n_sentences} sentences detected — need exactly 2")

    if issues:
        return _result(
            "highlights_prose_shape", "fail",
            "; ".join(issues),
        )
    return _result(
        "highlights_prose_shape", "pass",
        "Career Highlights has 2 sentences, no skills line — correct shape.",
    )


def _gate_highlights_reference_check(sections: Dict[str, str]) -> Dict[str, Any]:
    """
    Every Capitalised multi-word noun phrase used in Career Highlights
    (project names, product names, employers, technologies) must also
    appear somewhere in the body of the tailored CV (Experience,
    Projects, Skills, Education, Certifications). If not, the Highlights
    is referencing a "ghost" — content the AI dropped from the body.

    Heuristic — looks for tokens that match:
      - Capitalised phrases of 2+ words ("CV Agent", "YOLOv8n", "Power BI")
      - All-caps tokens of 3+ chars  ("ATS", "AWS")
      - Slash/hyphen-joined tech    ("Flutter/Dart")
    Common verbs and stop-cap words are excluded.
    """
    profile = _resolve_section(sections, _PROFILE_ALIASES)
    if not profile:
        return _result(
            "highlights_reference_check", "warn",
            "No Career Highlights to cross-check.",
        )

    body_blob = "\n".join(
        _resolve_section(sections, aliases)
        for aliases in (
            _EXPERIENCE_ALIASES, _PROJECTS_ALIASES,
            _SKILLS_ALIASES,     _EDUCATION_ALIASES,
            ("certifications",),
            # Family-specific sections that exist outside tech: nursing CVs
            # cite awards / registration credentials that DO live in the
            # body but in sections this gate didn't scan. Without these,
            # the gate falsely flags "Staff Excellence Award" as a ghost
            # reference (it's in ## Awards, not ## Experience).
            ("awards", "honours", "honors", "recognition"),
            ("registration & licences", "registration", "licences",
             "registrations", "licenses"),
        )
    )
    body_lower = body_blob.lower()

    # Ignore noise: months, generic action words, common adjectives, and
    # JD-title role-family words. The Summary's lead role often mirrors the
    # JD title ('Personal Care Worker', 'Care Support Worker', 'Compassionate
    # Care Worker') which won't literally appear in the candidate's
    # historical CV body — that's expected. JD-title phrases aren't ghosts.
    stopcaps = {
        # Tech role-family
        "data", "analyst", "engineer", "developer", "scientist", "manager",
        "lead", "senior", "principal", "staff", "director",
        # Care / nursing role-family — added so JD-title phrases like
        # "Personal Care Worker", "Compassionate Care Support Worker",
        # "Registered Nurse" don't get falsely flagged as ghost references.
        "personal", "care", "worker", "compassionate", "support", "assistant",
        "nursing", "registered", "enrolled", "carer", "aide", "ain", "rn",
        "en", "village", "in-home", "home", "community", "domiciliary",
        # Months
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
        "nov", "dec",
        # Verbs / generic action words
        "delivered", "built", "improved", "enhanced",
        "optimised", "optimized", "automated", "managed", "designed",
        "shipped", "migrated", "mentored",
        # Section labels
        "skills", "technical", "soft", "other",
        "career", "highlights", "professional", "experience",
        "education", "projects", "certifications", "summary", "profile",
    }

    candidates: List[str] = []
    # Multi-word Capitalised phrases (e.g. "CV Agent", "Power BI",
    # "Charles Darwin University"). Allow & and digits inside.
    multi_re = re.compile(
        r"\b([A-Z][\w&]*(?:\s+[A-Z][\w&]*){1,3})\b"
    )
    for m in multi_re.finditer(profile):
        token = m.group(1).strip()
        # Skip if every word is in stopcaps
        words = [w.lower() for w in re.split(r"\s+", token)]
        if all(w in stopcaps for w in words):
            continue
        candidates.append(token)

    # All-caps acronyms (3+ chars, optionally with digits)
    acro_re = re.compile(r"\b([A-Z]{3,}\d*)\b")
    for m in acro_re.finditer(profile):
        token = m.group(1)
        if token.lower() in stopcaps:
            continue
        candidates.append(token)

    # Slash/hyphen tech tokens — keep as-is for matching
    slash_re = re.compile(r"\b(\w+/\w+(?:/\w+)?)\b")
    for m in slash_re.finditer(profile):
        candidates.append(m.group(1))

    if not candidates:
        return _result(
            "highlights_reference_check", "pass",
            "No proper-noun references in Career Highlights to verify.",
        )

    # Dedupe while preserving order
    seen: set[str] = set()
    unique = [c for c in candidates if not (c.lower() in seen or seen.add(c.lower()))]

    missing = [c for c in unique if c.lower() not in body_lower]
    if missing:
        return _result(
            "highlights_reference_check", "fail",
            "Highlights references not found in CV body: "
            + ", ".join(missing[:5])
            + (f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""),
        )
    return _result(
        "highlights_reference_check", "pass",
        f"All {len(unique)} Highlights references present in the body.",
    )
