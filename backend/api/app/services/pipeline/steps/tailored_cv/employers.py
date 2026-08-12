"""Employer extraction and company-anchor enforcement.

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

import re
from ._common import logger
from .summary import (
    _find_summary_block,
    _get_summary_prose,
)

# Heading pattern that starts an Experience entry ("### Employer | Location").
_EXP_ENTRY_RE = re.compile(r"^###\s+(.+?)\s*(?:\|.*)?$")

# "## Experience"-style section headings (the normalizer emits "## Experience";
# tailored markdown uses "## Professional Experience"). Education/Certification
# entries also render as "### Institution | ..." with date spans, so the
# employer scan must not cross into those sections — a Master's degree is not
# an employer, and treating it as one injected garbage like "...Master of
# Professional Accounting at CQ University Sydney at Akala Motors and CQ
# University, Sydney, Australia." into the summary.
_EXP_SECTION_RE = re.compile(
    r"^##\s+(?:(?:professional|work|clinical)\s+)?experience\s*$"
    r"|^##\s+(?:employment|work|career)\s+history\s*$",
    re.IGNORECASE,
)


def _extract_employers_from_cv(cv_text: str, min_months: int = 2) -> list[str]:
    """Return employer names from the CV's Experience section that have
    continuous multi-month tenure (i.e. a date range like 'May 2025 – Jun 2026'
    or 'Mar 2026 – Present'). True placement entries (lines containing 'placement'
    with no genuine date span) are excluded; lines that merely mention weekly hours
    ('38 hrs/week') alongside a real date range are legitimate and included.
    Returns names in order of appearance (most recent first).

    When the CV has "## <section>" headings, only "### " entries inside an
    Experience-titled section count; a CV with bare "### " entries and no
    section headings is scanned whole (the legacy shape used by callers that
    pass experience-only fragments)."""
    employers: list[str] = []
    current_employer: str | None = None
    lines = [raw.strip() for raw in cv_text.split("\n")]
    # Whole-document scan only when the CV has no ## sections at all.
    has_sections = any(
        ln.startswith("## ") and not ln.startswith("###") for ln in lines
    )
    in_experience = not has_sections
    _DATE_SPAN_RE = re.compile(
        r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Present)"
        r".{1,20}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Present|\d{4})",
        re.IGNORECASE,
    )

    def _register(name: str, line: str) -> bool:
        """Register `name` as an employer if `line` carries a genuine multi-month
        date span. True placements (line contains 'placement') are skipped.
        Weekly-hours mentions ('38 hrs/week') are fine. Returns True if the line
        carried a date span (whether or not it registered), so the caller knows
        the entry has been resolved."""
        if not _DATE_SPAN_RE.search(line):
            return False
        if not re.search(r"\bplacement\b", line, re.IGNORECASE):
            if name not in employers:
                employers.append(name)
        return True

    for line in lines:
        if has_sections and line.startswith("## ") and not line.startswith("###"):
            in_experience = bool(_EXP_SECTION_RE.match(line))
            current_employer = None
            continue
        if not in_experience:
            continue
        m = _EXP_ENTRY_RE.match(line)
        if m:
            current_employer = m.group(1).strip()
            # The date span may sit inline on the heading line itself
            # ("### Employer | Location | May 2025 – Present"). Resolve it here
            # so we don't depend solely on the following line.
            if _register(current_employer, line):
                current_employer = None
            continue
        if current_employer and _register(current_employer, line):
            current_employer = None  # entry resolved — don't count twice
    return employers


_DANGLING_END_RE = re.compile(
    r"\b(?:and|or|while|with|for|to|at|in|of|the|a|an|by|as|but|yet|so"
    r"|that|which|where|who|whom|whose|including|across|through|within"
    r"|into|onto|from|than|nor)\s*\.?\s*$",
    re.IGNORECASE,
)


def _enforce_company_anchor(markdown: str, cv_text: str = "") -> str:
    """Two-mode anchor enforcer for the summary S2. Relies on the CV having
    2+ multi-month employers; no-op otherwise.

      • ZERO named — neither top-2 employer appears in the prose: append
                     "at <E1> and <E2>." to S2 (legacy behaviour).
      • PARTIAL    — exactly one of top-2 is named (the cherry-pick case
                     that produced the recent "...have served as a primary
                     Medication Assistant" Jane example): append a
                     semicolon-joined clause naming the missing employer
                     so BOTH appear, and convert a trailing "..., and have
                     <verb>" present-perfect tail into simple past (rule:
                     completed roles use past tense).

      Skipped when S2 ends mid-clause (dangling preposition/conjunction).
      Safe to no-op when cv_text is empty.
    """
    if not cv_text:
        return markdown
    employers = _extract_employers_from_cv(cv_text)
    if len(employers) < 2:
        return markdown

    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown

    top2 = employers[:2]
    prose_lower = prose.lower()
    named = [e for e in top2 if e.lower() in prose_lower]
    if len(named) >= 2:
        return markdown  # both named — compliant

    sent_re = re.compile(r"(?<=[.!?])\s+")
    sentences = [s.strip() for s in sent_re.split(prose) if s.strip()]
    if len(sentences) < 2:
        return markdown
    s1, s2 = sentences[0], sentences[1]
    if _DANGLING_END_RE.search(s2):
        logger.info("_enforce_company_anchor: S2 ends mid-clause, skipping injection")
        return markdown
    s2_body = s2.rstrip().rstrip(".")

    if len(named) == 0:
        anchor = f"at {top2[0]} and {top2[1]}"
        new_s2 = f"{s2_body} {anchor}."
        log_msg = f"injected anchor '{anchor}' (zero named)"
    else:
        missing = next(e for e in top2 if e.lower() not in prose_lower)
        # If S2 carries a trailing ", and (have) <verb>ed/-ing ..." tail
        # describing the unnamed role, splice the missing employer into IT
        # and flip present-perfect (have served / have led) → simple past
        # (served / led). Otherwise append a fresh semicolon-joined clause.
        m_tail = re.search(
            r",\s+and\s+(?:have\s+been\s+|have\s+)?\w+(?:ed|ing)\b",
            s2_body,
            re.IGNORECASE,
        )
        if m_tail:
            head = s2_body[: m_tail.start()].rstrip(",")
            tail = s2_body[m_tail.start() :]
            # Drop the leading ", and "
            tail = re.sub(r"^,\s+and\s+", "", tail, count=1, flags=re.IGNORECASE)
            # Present-perfect → simple past ("have served" → "served").
            tail = re.sub(
                r"^have\s+(been\s+)?(\w+ed|\w+en)\b",
                lambda mm: mm.group(2),
                tail,
                count=1,
                flags=re.IGNORECASE,
            )
            new_s2 = f"{head}; {tail} at {missing}."
            log_msg = f"partial cherry-pick: spliced missing '{missing}' into tail (past-tense)"
        else:
            new_s2 = f"{s2_body}; at {missing}."
            log_msg = f"partial cherry-pick: appended '; at {missing}'"

    new_prose = s1 + " " + new_s2
    lines[idx[0]] = new_prose
    for i in idx[1:]:
        lines[i] = ""
    logger.info("_enforce_company_anchor: %s", log_msg)
    return "\n".join(lines)
