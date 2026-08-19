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
    # C22g: "Clinical Experience" was nursing's own section_order heading
    # until commit e4a20824 (2026-05-30) renamed it to plain "Experience" —
    # several other modules (see pdf_generator/parsing.py's C22d fix) never
    # got cleaned up after the rename and still recognise the old phrase;
    # this regex didn't, so a CV headed this way silently produced an empty
    # experience list here (ATS tenure/vertical-alignment sub-scores zeroed,
    # honesty_guard's fabrication checks became no-ops).
    r"^##\s+(Experience|Work Experience|Professional Experience|Clinical Experience)\s*$",
    re.IGNORECASE,
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
# Finding #26 (chunk C21): a bare year with no month name ("2019 - 2023") is a
# common CV date format that _DATE_TOKEN_RE alone can't see — it requires a
# month name. Fall back to a plain 4-digit year, defaulting to January so a
# range built from two bare years doesn't overclaim tenure (e.g. "2019 -
# 2023" resolves to Jan 2019 - Jan 2023, not Jan 2019 - Dec 2023).
#
# Independent review: an earlier draft matched a bare year ANYWHERE in a
# line (`\b(19\d{2}|20\d{2})\b`). Because _parse_role_date_range is used as
# the PREDICATE that finds date-anchor lines in the plaintext parser (not
# just to parse a line already known to be a date), that unanchored match
# turned ordinary CV prose into spurious date-anchor lines and corrupted
# entry segmentation — an Australian postcode ("Sydney NSW 2000"), a metric
# ("supported over 2000 residents"), or a bullet ("registered with AHPRA
# since 2021") all falsely split entries and stole bullets from the real
# one. Fixed two ways: (1) _BARE_YEAR_ONLY_RE requires the WHOLE trimmed
# string to be just the year — used for the single-date whole-line fallback,
# so a sentence merely containing a year never matches; (2) a range match
# whose matched side is a bare year (no month name) must additionally sit at
# the start of the line or right after a role/date-line separator — a
# sentence like "...from 2019 to 2023." has "to" and two years, but nothing
# but prose immediately before "2019", so it's correctly rejected.
#
# Round 2 of that same review: a PREFIX-only check still leaked a bare-year
# range parenthesised or comma/colon-delimited mid-sentence — "Awarded
# Employee of the Year (2021 - 2022) for ward leadership." has a safe
# prefix ("(" right before "2021") but real prose AFTER the closing paren,
# which the prefix check alone can't see. Added a symmetric SUFFIX check:
# what follows the range must be nothing but an optional closing
# bracket/terminal punctuation and whitespace, not more sentence.
#
# Round 3: the suffix check alone isn't enough either — "Total headcount
# grew, 2019 - 2023." has an UNSAFE prefix (real prose before the comma)
# but a safe-looking suffix (just a trailing "."), so it slipped through.
# The prefix regex only ever looked at the single character immediately
# before the match, not whether anything meaningful preceded THAT — so
# ',' and ':' (which occur constantly inside ordinary sentences) were
# wrongly treated as reliable as '|' (which practically never is).
# Narrowed the safe-prefix set to characters that really are
# CV-structural, not just common punctuation: '|' ("Role | Date"), '('
# ("Role (Date)" — the matching suffix check already guards the case
# where prose follows the closing paren), and a leading bullet marker.
#
# Round 4: the SAME class of bug, one layer down. '•'/'·' were blessed as
# safe ANYWHERE in the prefix, not just as a genuine leading list marker —
# a bullet line using '•' a second time as a decorative separator
# ("• Employee of the Year • 2021 - 2022") has "•" right before the year
# but is exactly the mid-sentence-prose case this whole guard exists to
# reject. And '(' being optionally-closed in the suffix (`[)\]]?`) meant
# an UNCLOSED paren ("• Employee of the Year (2021 - 2022", no closing
# ")" anywhere — a plausible pypdf column-split artifact) looked just as
# safe as a genuinely closed one, since an empty end-of-line suffix passed
# either way. Fixed by: (a) a leading bullet/dash marker is only safe when
# it's the ENTIRE prefix from the start of the line (not merely present
# somewhere in it); (b) relying on '(' now REQUIRES an actual matching
# ')' immediately in the suffix, not an optional one.
_BARE_YEAR_ONLY_RE = re.compile(r"^(19\d{2}|20\d{2})$")
_SAFE_DATE_PREFIX_LEADING_RE = re.compile(r"^\s*[•·\-*]?\s*$")
_SAFE_DATE_PREFIX_PIPE_RE = re.compile(r"\|\s*$")
_SAFE_DATE_PREFIX_PAREN_RE = re.compile(r"\(\s*$")
_SAFE_DATE_SUFFIX_RE = re.compile(r"^[)\]]?\s*[.,;:]?\s*$")
# Round 4's own independent review found a FIFTH leak, in a different
# mechanism entirely: a line that is nothing but a bare year (no range at
# all) skips every prefix/suffix guard above, because there's no range to
# anchor. A pypdf column-split wrapping "Camperdown NSW" / "2050" across
# two lines then makes the postcode line look identical to a genuine
# standalone placement date. Used in _parse_plaintext_section_entries,
# which — unlike _parse_role_date_range — can see the previous line.
_AU_STATE_SUFFIX_RE = re.compile(
    r"\b(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s*$", re.IGNORECASE,
)
# Either side of a range may be "Mon YYYY" or a bare year — mixed forms
# ("Mar 2019 - 2023") are real too, not just symmetric ones.
_DATE_SIDE = r"(?:[A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4}|(?:19|20)\d{2})"
_DATE_RANGE_RE = re.compile(
    rf"({_DATE_SIDE})"
    r"\s*(?:[-–—]|\bto\b)\s*"
    rf"(Present|present|current|now|ongoing|{_DATE_SIDE})",
)


def _parse_month_year(s: str) -> Optional[Tuple[int, int]]:
    stripped = s.strip()
    m = _DATE_TOKEN_RE.search(stripped)
    if m:
        month = _MONTH_TO_NUM.get(m.group(1).lower())
        if month:
            return (int(m.group(2)), month)
    m2 = _BARE_YEAR_ONLY_RE.match(stripped)
    if m2:
        return (int(m2.group(1)), 1)
    return None


def _is_bare_year_side(side_text: str) -> bool:
    return bool(_BARE_YEAR_ONLY_RE.match(side_text.strip()))


def _parse_role_date_range(role_line: str):
    """Mirrors ``eval/writers/experience.py:_parse_role_date_range``. See that
    file for full design notes; inlined here to avoid the writers' import chain."""
    for m in _DATE_RANGE_RE.finditer(role_line):
        left, right = m.group(1), m.group(2)
        end_raw = right.strip().lower()
        right_is_open = end_raw in ("present", "current", "now", "ongoing")
        # A bare year (either side) must be anchored on BOTH sides — start
        # of line / a separator before it, and end of line / a closing
        # bracket or terminal punctuation after it — not embedded anywhere
        # inside a longer sentence.
        if _is_bare_year_side(left) or (not right_is_open and _is_bare_year_side(right)):
            prefix = role_line[: m.start()]
            suffix = role_line[m.end():]
            if _SAFE_DATE_PREFIX_LEADING_RE.match(prefix) or _SAFE_DATE_PREFIX_PIPE_RE.search(prefix):
                pass  # a leading marker or a "|" field separator — no closing bracket required
            elif _SAFE_DATE_PREFIX_PAREN_RE.search(prefix):
                # "(" only counts as safe if it's genuinely CLOSED — an
                # unclosed paren (pypdf column-split artifact) must not
                # look identical to a real "Role (Date)" line just because
                # the optional ")" in the suffix regex happens to be absent.
                if not suffix.startswith(")"):
                    continue
            else:
                continue
            if not _SAFE_DATE_SUFFIX_RE.match(suffix):
                continue
        start = _parse_month_year(left)
        if not start:
            continue
        if right_is_open:
            return (start, "present")
        end = _parse_month_year(right)
        if end:
            return (start, end)
    d = _parse_month_year(role_line)
    return (d, d) if d else None


def _find_experience_sections(lines: List[str]) -> List[Tuple[int, int]]:
    """Find ALL markdown experience-heading sections, not just the first.

    C22l: a CV can legitimately carry more than one heading matching
    _EXPERIENCE_HEADING_RE — e.g. a separate "## Clinical Experience" for
    placements and "## Work Experience" for paid roles. The old
    single-section version `break`d on the first match, silently dropping
    every entry under any subsequent matching heading. Mirrors
    _find_plaintext_experience_sections' multi-section loop below, which
    already collected all matches on the plaintext path.
    """
    sections: List[Tuple[int, int]] = []
    i = 0
    while i < len(lines):
        if _EXPERIENCE_HEADING_RE.match(lines[i]):
            start = i
            end = len(lines)
            for j in range(start + 1, len(lines)):
                if lines[j].startswith("## "):
                    end = j
                    break
            sections.append((start, end))
            i = end
        else:
            i += 1
    return sections


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
        stripped = ln.strip()
        if not _parse_role_date_range(stripped):
            continue
        if _BARE_YEAR_ONLY_RE.match(stripped):
            # Chunk C21 round 4's own review: a line that is NOTHING but a
            # bare year has no range to anchor against, so none of the
            # prefix/suffix guards above apply to it at all. A pypdf
            # column-split can wrap an address across two lines
            # ("Camperdown NSW" / "2050") — that trailing postcode line
            # then looks identical to a genuine standalone placement date
            # ("2023" alone, which test_single_bare_year_placement_parses
            # deliberately supports and this check must not break). This
            # function — unlike _parse_role_date_range — sees the
            # PREVIOUS line, so use it: an AU state abbreviation right
            # before a bare year is a wrapped postcode, not a date.
            prev = ""
            for j in range(i - 1, -1, -1):
                s = body_lines[j].strip()
                if s:
                    prev = s
                    break
            if _AU_STATE_SUFFIX_RE.search(prev):
                continue
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
    sections = _find_experience_sections(lines)
    entries: List[ExperienceEntry] = []
    for start_i, end_i in sections:
        body = lines[start_i + 1: end_i]
        blocks = _split_into_entries(body)
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
    if entries:
        return entries

    # ── Plain-text (pypdf) fallback ────────────────────────────────────────
    # C22m: also reached when a markdown heading matched but its section(s)
    # yielded zero entries (e.g. a genuinely hybrid document — a markdown
    # heading with no ### body, but real entries elsewhere in plaintext/
    # pypdf shape). The old code returned [] unconditionally the moment ANY
    # markdown heading matched, even an empty one, silently dropping
    # entries the plaintext path would have found.
    plain_sections = _find_plaintext_experience_sections(lines)
    if not plain_sections:
        return []
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
