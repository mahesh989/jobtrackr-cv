"""Structured CV experience extraction.

A thin wrapper that takes a Markdown CV's text and returns the per-role
entries from its ``## Experience`` section, with each entry tagged by the
vertical(s) its bullets evidence. Used by:

  • ATS v2 scoring (``app/services/pipeline/steps/ats_scoring.py``) — the
    deterministic experience score consumes ``relevant_tenure_months`` +
    ``vertical_alignment_ratio`` from this module instead of the legacy
    role-family freebie + AI ``raw_match_score``.

  • Anything else that needs to know "what kinds of work has this candidate
    actually done, when, and how long?" — bridges, summary composition,
    feasibility planning — could share this representation in future. Today
    those each scan ``cv_text`` ad-hoc.

Design rules:
  - Pure functions, no AI calls. Reuses the existing date parser and
    section finder from ``eval/writers/experience.py`` (the structure side
    of the CV is already a solved problem there).
  - Vertical detection uses the SAME ``classify()`` lexicon that JD analysis
    + skill categorisation use. One source of truth: when a phrase resolves
    to a nursing canonical, the entry is nursing-relevant. No bespoke
    vertical-marker regexes are introduced here. (The bridges' marker
    regexes in ``eval/writers/bridges.py`` are different — they detect
    nursing-INTERNAL settings like home/hospital/NDIS, not JD-family
    verticals like nursing/tech/cleaning. Both stay.)
  - Returns an empty list when no Experience section is found; callers
    must tolerate that. Real CVs sometimes title the section differently
    or omit it.

Date handling: ``today`` is injected (default ``date.today()``) so tests
are reproducible. "Present" / "current" / "ongoing" end dates are resolved
against this reference.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional, Tuple, Union

from app.services.skills.classifier import (
    _VERTICALS,
    classify,
    normalise,
)

# ---------------------------------------------------------------------------
# Section + date helpers (inlined from eval/writers/experience.py)
# ---------------------------------------------------------------------------
# Inlined deliberately: importing from ``eval.writers`` transitively pulls the
# pipeline orchestrator and DB config, which is the wrong direction for a leaf
# scoring helper. The originals are tiny and stable; keep a comment pointing
# at them so a future refactor can consolidate without surprise.

_EXPERIENCE_HEADING_RE = re.compile(
    r"^##\s+(Experience|Work Experience|Professional Experience)\s*$", re.IGNORECASE
)
# Plain-text (pypdf) section headers — all-caps variants for experience sections
_PLAIN_EXPERIENCE_SECTION_RE = re.compile(
    r"^\s*(CLINICAL\s+PLACEMENT|WORK\s+EXPERIENCE|PROFESSIONAL\s+EXPERIENCE|"
    r"EMPLOYMENT\s+HISTORY|WORK\s+HISTORY|CLINICAL\s+EXPERIENCE|"
    r"VOLUNTEER\s+EXPERIENCE|INTERNSHIP|EXPERIENCE)\s*$",
    re.IGNORECASE,
)
# All-caps section headers that terminate an experience section in plain text
_PLAIN_SECTION_RE = re.compile(r"^\s*[A-Z][A-Z\s&/,]+[A-Z]\s*$")
_MONTH_TO_NUM: Dict[str, int] = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_DATE_TOKEN_RE = re.compile(r"\b([A-Za-z]{3,9})\s+(?:\d{1,2}\s*,?\s*)?(\d{4})\b")
_DATE_RANGE_RE = re.compile(
    r"([A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4})"
    r"\s*(?:[-–—]|to)\s*"
    r"(Present|present|current|now|ongoing|[A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4})",
)


def _parse_month_year(s: str) -> Optional[Tuple[int, int]]:
    m = _DATE_TOKEN_RE.search(s.strip())
    if not m:
        return None
    month = _MONTH_TO_NUM.get(m.group(1).lower())
    return (int(m.group(2)), month) if month else None


def _parse_role_date_range(role_line: str):
    """Mirrors ``eval/writers/experience.py:_parse_role_date_range``. See that
    file for full design notes; inlined here to avoid the writers' import chain."""
    m = _DATE_RANGE_RE.search(role_line)
    if m:
        start = _parse_month_year(m.group(1))
        end_raw = m.group(2).strip().lower()
        if not start:
            return None
        if end_raw in ("present", "current", "now", "ongoing"):
            return (start, "present")
        end = _parse_month_year(end_raw)
        return (start, end) if end else None
    d = _parse_month_year(role_line)
    return (d, d) if d else None


def _find_experience_section(lines: List[str]) -> Optional[Tuple[int, int]]:
    start = None
    for i, ln in enumerate(lines):
        if _EXPERIENCE_HEADING_RE.match(ln):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return (start, end)


def _split_into_entries(body_lines: List[str]) -> List[List[str]]:
    indices = [i for i, ln in enumerate(body_lines) if ln.startswith("### ")]
    if not indices:
        return [body_lines]
    entries: List[List[str]] = []
    if indices[0] > 0:
        entries.append(body_lines[: indices[0]])
    for k, start in enumerate(indices):
        end = indices[k + 1] if k + 1 < len(indices) else len(body_lines)
        entries.append(body_lines[start:end])
    return entries


# ---------------------------------------------------------------------------
# Plain-text (pypdf) experience parsing — fallback when no Markdown headings
# ---------------------------------------------------------------------------

def _find_plaintext_experience_sections(lines: List[str]) -> List[Tuple[int, int]]:
    """Find all experience sections in a plain-text (pypdf) CV.

    Returns a list of (start, end) line-index pairs, one per section.
    Multiple sections (e.g. CLINICAL PLACEMENT + WORK EXPERIENCE) are each
    returned so their entries are all collected.
    """
    sections: List[Tuple[int, int]] = []
    i = 0
    while i < len(lines):
        if _PLAIN_EXPERIENCE_SECTION_RE.match(lines[i]):
            start = i
            end = len(lines)
            for j in range(i + 1, len(lines)):
                ln = lines[j].strip()
                if not ln:
                    continue
                # Next all-caps section header that is NOT an experience section ends this one
                if _PLAIN_SECTION_RE.match(lines[j]) and not _PLAIN_EXPERIENCE_SECTION_RE.match(lines[j]):
                    end = j
                    break
            sections.append((start, end))
            i = end
        else:
            i += 1
    return sections


def _parse_plaintext_section_entries(body_lines: List[str]) -> List["ExperienceEntry"]:
    """Parse employer blocks from one plain-text experience section body.

    Strategy: a line that matches a date range is the anchor for each entry.
    The 1-2 non-empty lines before it are employer + role; bullet lines
    (starting with • or -) that follow are the bullets.
    """
    # Find all date-range lines — each marks one entry
    date_positions = []
    for i, ln in enumerate(body_lines):
        if _parse_role_date_range(ln.strip()):
            date_positions.append(i)

    if not date_positions:
        return []

    entries: List[ExperienceEntry] = []
    for k, date_idx in enumerate(date_positions):
        # Employer / role: up to 2 non-empty lines immediately before the date line
        pre_lines = []
        j = date_idx - 1
        while j >= 0 and len(pre_lines) < 2:
            s = body_lines[j].strip()
            if s and not _PLAIN_SECTION_RE.match(body_lines[j]):
                pre_lines.insert(0, s)
            elif s:
                break
            j -= 1
        employer = pre_lines[0] if pre_lines else ""
        role = pre_lines[1] if len(pre_lines) > 1 else ""

        # Bullets: lines starting with • or - after the date line, until next entry
        next_date = date_positions[k + 1] if k + 1 < len(date_positions) else len(body_lines)
        bullets = []
        for b in range(date_idx + 1, next_date):
            s = body_lines[b].strip()
            if s.startswith(("•", "-", "*")) and len(s) > 2:
                bullets.append(s.lstrip("•-* ").strip())

        date_range = _parse_role_date_range(body_lines[date_idx].strip())
        if date_range:
            entry_start, entry_end = date_range
        else:
            entry_start, entry_end = None, None

        # Build a synthetic "role line" for vertical classification
        role_line = f"{role} {employer}"
        hits = _classify_entry_verticals(role_line, bullets)
        entries.append(ExperienceEntry(
            employer=employer,
            role=role,
            start=entry_start,
            end=entry_end,
            bullets=bullets,
            vertical_hits=hits,
        ))
    return entries


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

DateTuple = Tuple[int, int]                       # (year, month)
EndDate = Union[DateTuple, str, None]             # tuple, "present", or None
VerticalT = str                                   # "nursing" | "tech" | "cleaning"


@dataclass(frozen=True)
class ExperienceEntry:
    """One employer block from the CV's Experience section."""
    employer: str                  # H3 heading text, trimmed
    role: str                      # the italic role line, *…|…*
    start: Optional[DateTuple]
    end: EndDate
    bullets: List[str] = field(default_factory=list)
    # Count of lexicon-canonical hits per vertical inside the entry's
    # text (role line + bullets). Use this rather than a single "vertical"
    # field so consumers can decide the tagging policy (majority wins?
    # any hit? a ratio?). Empty dict means the entry hit no canonical in
    # any vertical — "other" vertical, weak signal.
    vertical_hits: Dict[VerticalT, int] = field(default_factory=dict)

    # --- tenure -----------------------------------------------------------

    def tenure_months(self, today: Optional[DateTuple] = None) -> int:
        """Months between start and end, inclusive of the start month.

        Returns 0 when start is unparseable; "present" end resolves to
        ``today`` (default: today's actual year/month). A placement
        entry (start == end) counts as one month.
        """
        if not self.start:
            return 0
        sy, sm = self.start
        if self.end == "present":
            if today is None:
                t = date.today()
                ey, em = t.year, t.month
            else:
                ey, em = today
        elif isinstance(self.end, tuple):
            ey, em = self.end
        else:
            return 0
        months = (ey - sy) * 12 + (em - sm) + 1
        return max(0, months)

    # --- vertical -------------------------------------------------------

    @property
    def primary_vertical(self) -> Optional[VerticalT]:
        """The vertical with the highest hit count, or None if all zero.

        Tie-break: ``_VERTICALS`` declaration order — irrelevant in
        practice because real CV entries rarely tie at >0 across two
        verticals (nursing CV bullets don't classify as tech)."""
        best, best_n = None, 0
        for v in _VERTICALS:
            n = self.vertical_hits.get(v, 0) or 0
            if n > best_n:
                best, best_n = v, n
        return best

    def matches_vertical(self, vertical: VerticalT) -> bool:
        """True when ≥1 phrase in the entry resolved to that vertical's
        lexicon. The single-hit floor avoids being defeated by edge
        cases ("collaboration" in a nursing bullet shouldn't pull the
        entry toward tech because the tech lexicon also has it).

        Note: a phrase that classifies in BOTH lexicons (e.g.
        "communication" exists for nursing AND tech) registers in both
        — so a heavy-nursing entry can still get one or two tech hits.
        The PRIMARY-vertical rule, not raw matches, is what drives
        ATS-side alignment scoring."""
        return (self.vertical_hits.get(vertical, 0) or 0) > 0


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

# Phrases inside each entry are tokenised on commas / "and" / bullets so the
# classifier sees individual skill candidates rather than full sentences. The
# JD/CV skill categoriser already operates on phrase lists; we mirror that.
_PHRASE_SPLIT_RE = re.compile(r"[,;•·\n]| and | & ", re.IGNORECASE)
# Filter very short tokens — single articles and stop words classify to noise
# false-positives. Three chars matches the classifier's own floor.
_MIN_PHRASE_LEN = 3


def _split_phrases(text: str) -> List[str]:
    """Break a bullet / role line into candidate skill phrases for
    classification. Conservative — when in doubt keep the phrase whole."""
    if not text:
        return []
    parts: List[str] = []
    for chunk in _PHRASE_SPLIT_RE.split(text):
        s = chunk.strip(" -*").strip()
        if len(s) >= _MIN_PHRASE_LEN:
            parts.append(s)
    return parts


def _classify_entry_verticals(role_line: str, bullets: List[str]) -> Dict[VerticalT, int]:
    """Count lexicon-canonical hits per vertical inside an entry's text.

    Each phrase candidate is classified once per vertical (the classifier
    is per-vertical). A phrase that resolves to a noise type doesn't
    count for anything — it's not a skill in any vertical.
    """
    phrases: List[str] = []
    if role_line:
        phrases.extend(_split_phrases(role_line))
    for b in bullets:
        phrases.extend(_split_phrases(b))

    hits: Dict[VerticalT, int] = {v: 0 for v in _VERTICALS}
    for phrase in phrases:
        if not normalise(phrase):
            continue
        for vertical in _VERTICALS:
            try:
                c = classify(phrase, vertical)
            except Exception:  # noqa: BLE001 — classification must never abort scoring
                continue
            if c and c.is_skill:
                hits[vertical] += 1
    return hits


def _extract_employer(entry_lines: List[str]) -> str:
    """The H3 employer heading is the first ``### …`` line in the block."""
    for ln in entry_lines:
        s = ln.strip()
        if s.startswith("### "):
            return s[4:].strip()
    return ""


def _extract_role_line(entry_lines: List[str]) -> str:
    """The first italic ``*Role | Dates*`` line, or first line containing
    a parseable date range. Returns '' if none found."""
    for ln in entry_lines:
        s = ln.strip()
        if not s:
            continue
        if s.startswith("*") and s.endswith("*"):
            return s.strip("*").strip()
        if _parse_role_date_range(s):
            return s
    return ""


def _extract_bullets(entry_lines: List[str]) -> List[str]:
    """Lines starting with a bullet marker (``-`` / ``*`` / ``•``). The role
    italic line is excluded — Markdown ``*…*`` looks like a ``*`` bullet
    without trailing space, but we already extracted it separately."""
    out: List[str] = []
    for ln in entry_lines:
        s = ln.strip()
        if not s:
            continue
        # Bullet markers: '-' / '*' followed by whitespace OR a '•' anywhere
        # at the start.
        if (s.startswith("- ") or s.startswith("* ") or s.startswith("• ")):
            out.append(s[2:].strip())
    return out


def parse_cv_experience(cv_text: str) -> List[ExperienceEntry]:
    """Parse the CV text's experience entries into structured records.

    Tries Markdown format first (``## Experience`` / ``### Employer``), then
    falls back to plain-text pypdf format (``WORK EXPERIENCE`` / ``CLINICAL
    PLACEMENT`` all-caps headers with date-anchored entries).

    Returns an empty list when no experience section is found in either format.
    Order is preserved (top-to-bottom in the source) — the ATS scorer doesn't
    require a particular order.
    """
    if not cv_text:
        return []
    lines = cv_text.split("\n")

    # ── Markdown path ──────────────────────────────────────────────────────
    section = _find_experience_section(lines)
    if section:
        start_i, end_i = section
        body = lines[start_i + 1: end_i]
        blocks = _split_into_entries(body)
        entries: List[ExperienceEntry] = []
        for block in blocks:
            if not block:
                continue
            if not any(ln.strip().startswith("### ") for ln in block):
                continue
            employer = _extract_employer(block)
            role_line = _extract_role_line(block)
            date_range = _parse_role_date_range(role_line) if role_line else None
            if date_range:
                entry_start, entry_end = date_range
            else:
                entry_start, entry_end = None, None
            bullets = _extract_bullets(block)
            hits = _classify_entry_verticals(role_line, bullets)
            entries.append(ExperienceEntry(
                employer=employer,
                role=role_line,
                start=entry_start,
                end=entry_end,
                bullets=bullets,
                vertical_hits=hits,
            ))
        return entries

    # ── Plain-text (pypdf) fallback ────────────────────────────────────────
    plain_sections = _find_plaintext_experience_sections(lines)
    if not plain_sections:
        return []
    entries = []
    for start_i, end_i in plain_sections:
        body = lines[start_i + 1: end_i]
        entries.extend(_parse_plaintext_section_entries(body))
    return entries


# ---------------------------------------------------------------------------
# Aggregates — what the ATS scorer actually consumes
# ---------------------------------------------------------------------------

def relevant_tenure_months(
    entries: List[ExperienceEntry],
    vertical: Optional[str],
    *,
    today: Optional[DateTuple] = None,
) -> int:
    """Total months across entries whose primary vertical equals
    ``vertical``. Returns 0 when vertical is None / empty / no match.

    Uses ``primary_vertical`` (winner-take-all per entry) so a tech CV
    with one nursing-flavoured volunteer line doesn't double-count toward
    both — each entry is in at most one vertical.
    """
    if not vertical or not entries:
        return 0
    total = 0
    for e in entries:
        if e.primary_vertical == vertical:
            total += e.tenure_months(today)
    return total


def vertical_alignment_ratio(
    entries: List[ExperienceEntry], vertical: Optional[str],
) -> float:
    """Fraction of entries whose primary vertical equals ``vertical``.
    Returns 0.0 when vertical is None / empty / there are no entries.

    Range: [0.0, 1.0]. Entries with no lexicon hits in any vertical
    (``primary_vertical is None``) count toward the denominator but not
    the numerator — exactly what we want for the ATS alignment signal
    (filler entries dilute the alignment, they don't pad it).
    """
    if not vertical or not entries:
        return 0.0
    aligned = sum(1 for e in entries if e.primary_vertical == vertical)
    return aligned / len(entries)
