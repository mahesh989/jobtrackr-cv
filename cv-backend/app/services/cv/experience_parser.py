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
    """Parse the Markdown CV's ``## Experience`` section into structured
    entries. Returns an empty list when the section is absent or empty.

    Order is preserved (top-to-bottom in the source markdown) — callers
    that need reverse-chronological can sort by ``start`` themselves; for
    the ATS scorer the order doesn't matter.
    """
    if not cv_text:
        return []
    lines = cv_text.split("\n")
    section = _find_experience_section(lines)
    if not section:
        return []
    start_i, end_i = section
    body = lines[start_i + 1: end_i]
    blocks = _split_into_entries(body)
    if not blocks:
        return []

    entries: List[ExperienceEntry] = []
    for block in blocks:
        if not block:
            continue
        # Skip an orphan 'pre' block — it has no H3 employer line.
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
