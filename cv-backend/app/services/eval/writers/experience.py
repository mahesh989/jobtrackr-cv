"""Experience-section processing — extracted from writers._impl.

Pure, deterministic transforms over the CV's Experience section: month/date
parsing, chronological ordering of roles, and past/present tense normalisation
of bullets. Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
import re
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# Month name → number. Includes the abbreviations the writer prompt uses
# (Sept rather than Sep, June rather than Jun) and their full names.
_MONTH_TO_NUM: Dict[str, int] = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

# Past tense → infinitive/present (3rd-person-singular dropped — bullets are
# usually subjectless, so "Serve" is the bare form). The map is bidirectional
# in spirit: present→past is computed by inverting at module load.
#
# Curated for nursing / clinical / generic CV verbs. Easy to extend per
# vertical. Excludes verbs with irregular present-tense forms that would
# read awkwardly without a subject (e.g. "writes" → "Write" is OK; "wrote"
# stays "Wrote" already).
_PAST_TO_PRESENT_VERBS: Dict[str, str] = {
    "served":         "Serve",
    "delivered":      "Deliver",
    "provided":       "Provide",
    "monitored":      "Monitor",
    "maintained":     "Maintain",
    "collaborated":   "Collaborate",
    "managed":        "Manage",
    "ensured":        "Ensure",
    "supported":      "Support",
    "executed":       "Execute",
    "transported":    "Transport",
    "coordinated":    "Coordinate",
    "assisted":       "Assist",
    "supervised":     "Supervise",
    "documented":     "Document",
    "responded":      "Respond",
    "handled":        "Handle",
    "engaged":        "Engage",
    "promoted":       "Promote",
    "trained":        "Train",
    "liaised":        "Liaise",
    "communicated":   "Communicate",
    "led":            "Lead",
    "developed":      "Develop",
    "implemented":    "Implement",
    "improved":       "Improve",
    "analysed":       "Analyse",
    "analyzed":       "Analyse",
    "reviewed":       "Review",
    "prepared":       "Prepare",
    "tracked":        "Track",
    "reported":       "Report",
    "updated":        "Update",
    "coached":        "Coach",
    "mentored":       "Mentor",
    "educated":       "Educate",
    "partnered":      "Partner",
    "resolved":       "Resolve",
    "escalated":      "Escalate",
    "built":          "Build",
    "designed":       "Design",
    "created":        "Create",
    "identified":     "Identify",
    "conducted":      "Conduct",
    "fostered":       "Foster",
    "facilitated":    "Facilitate",
    "advised":        "Advise",
    "consulted":      "Consult",
    "audited":        "Audit",
    "evaluated":      "Evaluate",
    "investigated":   "Investigate",
    "performed":      "Perform",
    "researched":     "Research",
    "drafted":        "Draft",
    "presented":      "Present",
    "led":            "Lead",
    "guided":         "Guide",
    "led":            "Lead",
    "championed":     "Champion",
    "completed":      "Complete",
    "achieved":       "Achieve",
    "drove":          "Drive",
    "wrote":          "Write",
    "produced":       "Produce",
    "applied":        "Apply",
    "deployed":       "Deploy",
    "negotiated":     "Negotiate",
}
# Invert for present → past lookup. The capitalised past tense is what gets
# emitted at bullet start, so we store the inflected form.
_PRESENT_TO_PAST_VERBS: Dict[str, str] = {
    present.lower(): past.capitalize() for past, present in _PAST_TO_PRESENT_VERBS.items()
}

_DATE_TOKEN_RE = re.compile(
    r"\b([A-Za-z]{3,9})\s+(?:\d{1,2}\s*,?\s*)?(\d{4})\b"
)
_DATE_RANGE_RE = re.compile(
    r"([A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4})"
    r"\s*(?:[-–—]|to)\s*"
    r"(Present|present|current|now|ongoing|[A-Za-z]{3,9}\s+(?:\d{1,2}\s*,?\s*)?\d{4})",
)


def _parse_month_year(s: str) -> Optional[tuple[int, int]]:
    """Parse 'Mar 2026' / 'Sept 2024' / 'Sept 20, 2024' / 'May 2025' to
    (year, month). Returns None on unparseable input."""
    m = _DATE_TOKEN_RE.search(s.strip())
    if not m:
        return None
    month_name = m.group(1).lower()
    year = int(m.group(2))
    month = _MONTH_TO_NUM.get(month_name)
    return (year, month) if month else None


def _parse_role_date_range(role_line: str) -> Optional[tuple[tuple[int, int], object]]:
    """Extract (start, end) from a role/date line like
    '*Care Worker (Casual) | Mar 2026 – Present*'.

    Returns ((start_year, start_month), end) where end is either the literal
    string "present" or a (year, month) tuple. Returns None if no range
    found. A single date (placement) → start == end.
    """
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
    # Single date (placement) — treat as a fixed point in time.
    d = _parse_month_year(role_line)
    if d:
        return (d, d)
    return None


def _is_present_role(date_range: Optional[tuple]) -> bool:
    """True when the role end is 'present'."""
    if not date_range:
        return False
    _, end = date_range
    return end == "present"


_EXPERIENCE_HEADING_RE = re.compile(r"^##\s+(Experience|Work Experience|Professional Experience)\s*$", re.IGNORECASE)


def _find_experience_section(lines: list[str]) -> Optional[tuple[int, int]]:
    """Return (heading_index, body_end_index_exclusive). None if no Experience section."""
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


def _split_into_entries(body_lines: list[str]) -> list[list[str]]:
    """Split an Experience section's body into per-entry blocks.

    An entry starts at an H3 heading (`### `) and runs until the next H3.
    Lines before the first H3 (orphans) are returned as a leading 'pre'
    block — preserved as-is by callers.
    """
    entries: list[list[str]] = []
    indices = [i for i, ln in enumerate(body_lines) if ln.startswith("### ")]
    if not indices:
        return [body_lines]  # no H3 — return whole thing as one block
    if indices[0] > 0:
        entries.append(body_lines[:indices[0]])
    for k, start in enumerate(indices):
        end = indices[k + 1] if k + 1 < len(indices) else len(body_lines)
        entries.append(body_lines[start:end])
    return entries


def _find_role_line(entry_block: list[str]) -> tuple[int, Optional[tuple]]:
    """Return (index_of_role_line, parsed_date_range) for an entry. The role
    line is the italic line `*Role | Dates*` that follows the H3 employer line.
    Returns (-1, None) if no parseable date line found."""
    for idx, ln in enumerate(entry_block):
        if ln.strip().startswith("*") and ln.strip().endswith("*"):
            parsed = _parse_role_date_range(ln)
            if parsed:
                return (idx, parsed)
        # Fall back: any line with a date range pattern.
        if _DATE_RANGE_RE.search(ln) or _DATE_TOKEN_RE.search(ln):
            parsed = _parse_role_date_range(ln)
            if parsed:
                return (idx, parsed)
    return (-1, None)


def sort_experience_chronologically(markdown: str) -> str:
    """Sort Experience entries reverse-chronological:
      1. Present (ongoing) roles by start_date DESC
      2. Then ended roles by end_date DESC, start_date DESC
    Entries with unparseable dates sort to the end, preserving relative order.

    Idempotent — running twice produces identical output.
    """
    lines = markdown.split("\n")
    exp = _find_experience_section(lines)
    if not exp:
        return markdown
    start, end = exp
    body = lines[start + 1:end]
    entry_blocks = _split_into_entries(body)
    if len(entry_blocks) <= 1:
        return markdown

    # The first block may be a 'pre' block (lines before any H3). Keep it pinned at top.
    pre_block: list[str] = []
    if entry_blocks and not entry_blocks[0] or (entry_blocks[0] and not entry_blocks[0][0].startswith("### ")):
        pre_block = entry_blocks[0]
        entry_blocks = entry_blocks[1:]
    if not entry_blocks:
        return markdown

    # Parse date range for each entry.
    parsed: list[tuple[Optional[tuple], list[str], int]] = []
    for idx, block in enumerate(entry_blocks):
        _, dr = _find_role_line(block)
        parsed.append((dr, block, idx))

    def sort_key(item: tuple[Optional[tuple], list[str], int]) -> tuple:
        dr, _, original_idx = item
        if dr is None:
            return (3, original_idx, 0, 0)  # unparseable → end, stable order
        s, e = dr
        if e == "present":
            return (1, -s[0], -s[1], original_idx)  # ongoing, start desc
        # ended → end_date desc, then start desc
        return (2, -e[0], -e[1], -s[0], -s[1])

    parsed.sort(key=sort_key)
    # Idempotency: if sorting produced the SAME order as the input, return
    # markdown unchanged. Prevents the re-emit pass from drifting whitespace
    # on already-correctly-ordered Experience sections (most LLM output now
    # gets this right). The original_idx values are 0,1,2,... in input order;
    # check whether they remain monotone after sort.
    if all(parsed[i][2] == i for i in range(len(parsed))):
        return markdown

    # Re-emit. Trim trailing blank lines on each block, then join with one blank.
    sorted_blocks = [_strip_trailing_blank(b) for _, b, _ in parsed]
    new_body: list[str] = list(pre_block)
    for k, blk in enumerate(sorted_blocks):
        if k > 0 and new_body and new_body[-1].strip():
            new_body.append("")
        new_body.extend(blk)
    # Preserve one trailing blank line so the next section ("## Education")
    # stays separated by a blank line as it was in the input.
    if new_body and new_body[-1].strip():
        new_body.append("")

    out = lines[:start + 1] + new_body + lines[end:]
    return "\n".join(out)


def _strip_trailing_blank(block: list[str]) -> list[str]:
    out = list(block)
    while out and not out[-1].strip():
        out.pop()
    return out


_BULLET_FIRST_WORD_RE = re.compile(r"^(\s*[-*•]\s+)(\w+)(.*)$")


def _convert_bullet_tense(bullet: str, *, want_present: bool) -> str:
    """Convert the first word of a bullet to match the desired tense.
    Only touches the first word; preserves bullet marker, indentation,
    capitalisation rule (every bullet starts capitalised), and the rest.

    Returns the bullet unchanged when:
      • The line isn't a bullet
      • The first word isn't in the verb map
      • The first word is already in the correct tense
    """
    m = _BULLET_FIRST_WORD_RE.match(bullet)
    if not m:
        return bullet
    marker, first_word, rest = m.groups()
    fw_lower = first_word.lower()
    if want_present:
        replacement = _PAST_TO_PRESENT_VERBS.get(fw_lower)
        if replacement:
            return marker + replacement + rest
    else:
        replacement = _PRESENT_TO_PAST_VERBS.get(fw_lower)
        if replacement:
            return marker + replacement + rest
    return bullet


def normalise_experience_tense(markdown: str) -> str:
    """For each Experience entry, force the first verb of every bullet to
    match the role's date status:
      • End == "Present" → first verb in PRESENT tense (Serve, Provide, ...)
      • End is a past date → first verb in PAST tense (Served, Provided, ...)

    Verbs not in the table are left untouched. Idempotent.
    """
    lines = markdown.split("\n")
    exp = _find_experience_section(lines)
    if not exp:
        return markdown
    start, end = exp
    body = lines[start + 1:end]
    entry_blocks = _split_into_entries(body)
    if not entry_blocks:
        return markdown

    changes = 0
    new_body: list[str] = []
    for block in entry_blocks:
        if not block or not block[0].startswith("### "):
            new_body.extend(block)
            continue
        _, dr = _find_role_line(block)
        is_present = _is_present_role(dr)
        new_block: list[str] = []
        for ln in block:
            if ln.lstrip()[:2] in ("- ", "* ") or ln.lstrip()[:1] == "•":
                converted = _convert_bullet_tense(ln, want_present=is_present)
                if converted != ln:
                    changes += 1
                new_block.append(converted)
            else:
                new_block.append(ln)
        new_body.extend(new_block)

    if changes:
        logger.info("sprint-B tense normaliser: rewrote %d bullet verb(s)", changes)

    out = lines[:start + 1] + new_body + lines[end:]
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Module 6 — date format normaliser.
#
# Strip day-of-month from CV dates. "Sept 20, 2024" → "Sept 2024". The
# day-of-month is non-standard for CV resume dates and looks out of place
# next to month-only siblings.
# ---------------------------------------------------------------------------

_DATE_WITH_DAY_RE = re.compile(
    r"\b([A-Za-z]{3,9})\s+\d{1,2}\s*,\s*(\d{4})\b"
)


def normalise_date_formats(markdown: str) -> str:
    """Strip day-of-month from `Month DD, YYYY` patterns to `Month YYYY`.

    Conservative — only matches month names + 1-2 digit day + comma + 4-digit
    year. Doesn't touch single-month-name dates or month-year ranges.
    """
    if not markdown:
        return markdown
    # Replace only when the leading token is a recognised month abbreviation/name.
    def _sub(m: "re.Match") -> str:
        month = m.group(1)
        year = m.group(2)
        if month.lower() not in _MONTH_TO_NUM:
            return m.group(0)  # not a month name → leave alone
        return f"{month} {year}"
    return _DATE_WITH_DAY_RE.sub(_sub, markdown)
