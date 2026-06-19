"""JD pre-filtering — strip boilerplate sections before the LLM sees the text.

Raw SEEK-scraped job descriptions contain "About Us", benefits, EEO disclaimers,
reporting structure, and "How to Apply" sections that add noise and cost tokens
without contributing skill signal. This module strips those sections so the LLM
only receives skill-relevant content.

Usage
-----
    from app.services.preprocessing.jd_cleaner import clean_jd_text

    cleaned, section_map = clean_jd_text(payload.jd_text)
    # Pass `cleaned` to run_jd_analysis; keep payload.jd_text for all other steps.

Design rules
------------
- Pure Python, stdlib `re` only. Zero external dependencies.
- Conservative: if fewer than one skill section is detected the full raw text is
  returned unchanged so the LLM is never starved of content.
- Content before the first heading (preamble) is always kept — it typically
  contains the job title and a brief overview the LLM needs for context.
- Unknown headings (not in either known set) are kept rather than discarded
  ("when in doubt, keep").
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Heading classification vocabularies
# ---------------------------------------------------------------------------

# Normalised (lowercase, no trailing colon) heading strings that signal
# skill-relevant content. All content under these headings is forwarded to
# the LLM.  Keep the set comprehensive — missing a heading here means the
# cleaner silently demotes it to "unknown" (still kept), so the downside is
# minor, but having it explicit avoids repeated "unknown" log noise.
_SKILL_HEADINGS: frozenset[str] = frozenset({
    # Generic requirements / qualifications
    "requirements",
    "required",
    "qualifications",
    "minimum requirements",
    "essential requirements",
    "essential skills",
    "essential criteria",
    "essential experience",
    "preferred qualifications",
    "preferred skills",
    "desirable",
    "desirable criteria",
    "desirable skills",
    "nice to have",
    "selection criteria",
    "key selection criteria",
    "position requirements",
    "job requirements",
    "technical requirements",
    "technical skills",
    "technical experience",
    "must haves",
    # About / profile / identity
    "about you",
    "who you are",
    "your profile",
    "your background",
    "you bring",
    "you will bring",
    "what you bring",
    "what you need",
    "what you'll need",
    "what you will need",
    "what you must have",
    "what are we looking for",
    "who are we looking for",
    "what we are looking for",
    "what we're looking for",
    "we need",
    "who we need",
    # Responsibilities / duties
    "responsibilities",
    "key responsibilities",
    "duties",
    "key duties",
    "main duties",
    "key tasks",
    "accountabilities",
    "key accountabilities",
    # Role description
    "the role",
    "about the role",
    "about the position",
    "the position",
    "role overview",
    "position overview",
    "role description",
    "position description",
    "the opportunity",
    "about the opportunity",
    "your role",
    # What you will do
    "what you'll do",
    "what you will do",
    "what you will be doing",
    "your duties",
    # Skills / experience
    "skills",
    "experience",
    "experience required",
    "required experience",
    "required skills",
    "your experience",
    "your skills",
    "skills and experience",
    "skills & experience",
    "knowledge and experience",
    "skills and qualifications",
    # Competencies
    "competencies",
    "key competencies",
    "clinical requirements",
    "clinical skills",
    "care requirements",
    # Success criteria
    "what you need to be successful",
    "to be successful",
    "for the role",
    "to be considered",
    "you will need",
    "you will have",
    "you will be",
})

# Normalised heading strings that signal boilerplate content. All content
# under these headings is discarded before the text reaches the LLM.
_BOILERPLATE_HEADINGS: frozenset[str] = frozenset({
    # About the company
    "about us",
    "about the company",
    "about the organisation",
    "about the organization",
    "about our company",
    "about our organisation",
    "about our organization",
    "about our client",
    "our client",
    "who is our client",
    "who we are",
    "the company",
    "the organisation",
    "the organization",
    "our story",
    # Culture / values (company-perspective)
    "culture",
    "team culture",
    "work culture",
    "our culture",
    "our values",
    "our team",
    "our workplace",
    "our environment",
    # Benefits / perks / offer
    "benefits",
    "our benefits",
    "the benefits",
    "employee benefits",
    "staff benefits",
    "perks",
    "what we offer",
    "we offer",
    "our offer",
    "what's in it for you",
    "what is in it for you",
    # Why join
    "why join us",
    "why work with us",
    "why work for us",
    "working with us",
    "working here",
    "why us",
    # EEO / diversity
    "eeo",
    "equal opportunity",
    "equal employment opportunity",
    "diversity statement",
    "diversity and inclusion",
    # How to apply
    "to apply",
    "how to apply",
    "apply now",
    "application process",
    "application details",
    "next steps",
    "to submit an application",
    "for more information",
    "enquiries",
    "questions",
    # Reporting / structure
    "reporting to",
    "reporting line",
    "reporting structure",
    # Working conditions
    "working hours",
    "working arrangements",
    "hours of work",
    # Salary / contract
    "salary",
    "remuneration",
    "compensation",
    "pay",
    # Job metadata
    "location",
    "job type",
    "employment type",
    "work type",
    "contract type",
    "position type",
})


# ---------------------------------------------------------------------------
# Heading detection
# ---------------------------------------------------------------------------

# Strip leading markdown/heading markers (##, *, **) before classification.
_MARKDOWN_PREFIX_RE = re.compile(r"^[#*]+\s*")
_MARKDOWN_SUFFIX_RE = re.compile(r"\s*[#*]+$")

# Lines starting with these tokens are bullet items, not headings.
_BULLET_PREFIX_RE = re.compile(r"^[\-\*•○◦→►▪▶]\s+")

# Sentence-terminal characters that disqualify a line from being a heading.
_SENTENCE_TERMINAL_RE = re.compile(r"[.!?]$")

# Maximum character length of a bare heading (after stripping markers + colon).
_MAX_HEADING_LEN = 80


def _strip_markers(line: str) -> str:
    """Remove markdown heading/bold markers from both ends of a line."""
    s = _MARKDOWN_PREFIX_RE.sub("", line).strip()
    s = _MARKDOWN_SUFFIX_RE.sub("", s).strip()
    return s


def _normalise_heading(line: str) -> str:
    """Return a lowercase, colon-stripped, marker-stripped heading string
    suitable for lookup against _SKILL_HEADINGS / _BOILERPLATE_HEADINGS."""
    s = _strip_markers(line).strip()
    if s.endswith(":"):
        s = s[:-1].rstrip()
    return s.lower()


def _is_heading_line(line: str) -> bool:
    """Return True if `line` looks like a section heading.

    Heuristics (all must pass unless the colon rule fires):
    - Not blank
    - Does not start with a bullet marker
    - Bare text (after stripping markdown) is ≤ _MAX_HEADING_LEN chars
    - Does not end with ., !, ? (sentence terminals)
    - Either: ends with a colon  OR  is ≥3-char ALL CAPS  OR  matches a known
      heading in either vocabulary (title-case lines only accepted if listed).
    """
    s = line.strip()
    if not s:
        return False
    if _BULLET_PREFIX_RE.match(s):
        return False

    bare = _strip_markers(s)
    if len(bare) > _MAX_HEADING_LEN:
        return False
    if _SENTENCE_TERMINAL_RE.search(bare):
        return False

    # Most reliable signal: line ends with a colon.
    if bare.endswith(":"):
        return True

    # ALL CAPS heading (e.g. "REQUIREMENTS", "ABOUT US").
    # isupper() returns False for strings with no letters (e.g. "---"), so this
    # is safe against horizontal-rule lines.
    if bare.isupper() and len(bare) >= 3:
        return True

    # Title-case or mixed-case short line: only accept when it matches a known
    # heading to avoid treating inline sentence fragments as headings.
    norm = bare.lower()
    if norm in _SKILL_HEADINGS or norm in _BOILERPLATE_HEADINGS:
        return True

    return False


def _classify_heading(line: str) -> str:
    """Classify a detected heading line as ``'skill'``, ``'boilerplate'``,
    or ``'unknown'``.

    'unknown' headings are kept (conservative default) — when a heading isn't
    in either list it's more likely a legitimate role-specific section than
    boilerplate we missed.
    """
    norm = _normalise_heading(line)
    if norm in _SKILL_HEADINGS:
        return "skill"
    if norm in _BOILERPLATE_HEADINGS:
        return "boilerplate"
    return "unknown"


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

# Require at least this many detected skill headings before we attempt
# filtering. Below this threshold the full raw text is returned unchanged to
# avoid stripping content from unstructured JDs.
_MIN_SKILL_SECTIONS = 1


def clean_jd_text(raw_text: str) -> Tuple[str, Dict[str, str]]:
    """Strip boilerplate sections from a raw job description.

    Algorithm
    ---------
    1. Split ``raw_text`` line-by-line.
    2. Identify heading lines using ``_is_heading_line``.
    3. Classify each heading as ``skill`` | ``boilerplate`` | ``unknown``.
    4. Accumulate lines into the current section.
    5. On heading transition, flush the completed section:
       - ``skill`` or ``unknown`` → append heading + content to output.
       - ``boilerplate`` → discard content.
    6. Preamble (content before any heading) is always kept — it typically
       contains the job title and role summary that give the LLM context.
    7. Fallback: if fewer than ``_MIN_SKILL_SECTIONS`` skill headings are
       detected, return the unmodified ``raw_text``. This prevents aggressive
       stripping of unstructured JDs that happen to use unfamiliar headings.

    Parameters
    ----------
    raw_text:
        The raw JD text as scraped (may include About-Us, benefits, EEO, etc.)

    Returns
    -------
    cleaned_text:
        Skill-relevant content only (preamble + skill/unknown sections).
        Equals ``raw_text`` when the fallback triggers.
    section_map:
        Mapping of ``{heading: content}`` for every parsed section (both kept
        and discarded). Useful for debugging, evidence extraction, and later
        recall-floor scoping. Special keys:
        - ``"_preamble"``   — content before the first heading
        - ``"_fallback"``   — ``"true"`` when fallback was used
        - ``"_boilerplate"``— comma-separated list of discarded headings
    """
    if not raw_text:
        return "", {}

    lines = raw_text.split("\n")

    # ------------------------------------------------------------------
    # Pass 1: Segment lines into (heading, kind, content_lines) tuples.
    # ------------------------------------------------------------------
    # Each tuple represents one section: (heading text | None, kind, lines).
    # The first tuple always has heading=None and kind="preamble".
    Section = Tuple[Optional[str], str, List[str]]
    sections: List[Section] = []

    current_heading: Optional[str] = None   # None → preamble
    current_kind: str = "preamble"
    current_lines: List[str] = []

    for line in lines:
        if _is_heading_line(line):
            sections.append((current_heading, current_kind, current_lines))
            current_heading = line.strip()
            current_kind = _classify_heading(line)
            current_lines = []
        else:
            current_lines.append(line)

    # Flush the last open section.
    sections.append((current_heading, current_kind, current_lines))

    # ------------------------------------------------------------------
    # Pass 2: Decide whether to filter or fall back.
    # ------------------------------------------------------------------
    skill_count = sum(1 for _, kind, _ in sections if kind == "skill")
    section_map: Dict[str, str] = {}
    boilerplate_headings: List[str] = []

    if skill_count < _MIN_SKILL_SECTIONS:
        # No identifiable skill sections — return raw text intact.
        section_map["_fallback"] = "true"
        for heading, kind, content_lines in sections:
            key = heading if heading is not None else "_preamble"
            section_map[key] = "\n".join(content_lines).strip()
        return raw_text, section_map

    # ------------------------------------------------------------------
    # Pass 3: Assemble the filtered output.
    # ------------------------------------------------------------------
    kept_parts: List[str] = []

    for heading, kind, content_lines in sections:
        content_text = "\n".join(content_lines).strip()
        key = heading if heading is not None else "_preamble"
        section_map[key] = content_text

        if kind == "boilerplate":
            if heading:
                boilerplate_headings.append(heading)
            # Content discarded — do not add to kept_parts.
        else:
            # preamble, skill, or unknown → keep.
            if heading:
                kept_parts.append(heading)
            if content_text:
                kept_parts.append(content_text)

    if boilerplate_headings:
        section_map["_boilerplate"] = ", ".join(boilerplate_headings)

    cleaned_text = "\n".join(kept_parts).strip()

    # Safety net: if assembly somehow produced empty output, fall back.
    if not cleaned_text.strip():
        section_map["_fallback"] = "true"
        return raw_text, section_map

    return cleaned_text, section_map
