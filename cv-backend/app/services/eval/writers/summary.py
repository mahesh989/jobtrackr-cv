"""Professional Summary S2 enforcer — extracted from writers._impl.

Deterministic honesty gate for the summary's second sentence: extracts present
employers + named tools from the ORIGINAL CV, verifies the AI-written S2 carries
concrete evidence (employer name / metric), and rebuilds it deterministically
when it doesn't. Moved verbatim (own module logger; _KNOWN_CV_TOOLS stays in
_impl with the Skills surfacer and is lazy-imported at its one call site here).
"""
from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Phase 2 Sprint E — Professional Summary S2 enforcer.
#
# The Summary's second sentence (S2) is supposed to ground the candidate's
# capabilities in CONCRETE evidence — a named employer, a named tool, or a
# numeric metric. The writer prompt asks for this, but the LLM frequently
# emits generic filler:
#
#   "Provides safe, respectful support for older people in facility environments."
#   "Delivered safe medication assistance and comprehensive personal care to
#    elderly residents using electronic systems and behavioural management
#    techniques and during placement across these settings."
#
# Both score the same on ATS (no extra keywords) but waste the recruiter's
# 8-second skim window. Sprint E: when S2 contains NO concrete evidence
# (no employer name from Experience, no CV-named brand tool, no metric),
# REPLACE it with a deterministic employer/tool-naming sentence built from
# the original CV.
# ---------------------------------------------------------------------------

_SUMMARY_HEADINGS = ("professional summary", "summary", "profile", "career highlights")
_SENT_END_RE = re.compile(r"(?<=[.!?])\s+")
_METRIC_TOKEN_RE = re.compile(r"\b\d+(?:[\.,]\d+)?\s*(?:%|years|yrs|hours|hrs|residents|patients|beds|shifts|clients|sites|rooms)\b", re.IGNORECASE)


def _find_summary_section(lines: list[str]) -> Optional[tuple[int, int]]:
    """Return (heading_index, body_end_exclusive). None if no Summary section."""
    for i, ln in enumerate(lines):
        if ln.startswith("## ") and ln[3:].strip().lower() in _SUMMARY_HEADINGS:
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if lines[j].startswith("## "):
                    end = j
                    break
            return (i, end)
    return None


def _extract_summary_prose(lines: list[str], start: int, end: int) -> tuple[str, list[int]]:
    """Return (full_prose_string, list_of_line_indices_that_contained_prose)."""
    prose_idx: list[int] = []
    for i in range(start + 1, end):
        s = lines[i].strip()
        if s and not s.startswith(("- ", "* ", "•")):
            prose_idx.append(i)
    if not prose_idx:
        return ("", [])
    text = " ".join(lines[i].strip() for i in prose_idx)
    return (text.strip(), prose_idx)


def _extract_present_employers_from_experience(cv_text: str) -> list[str]:
    """Pull employer/institution names from the CV's Experience section,
    prioritising ongoing ('Present') roles. Returns unique names in their
    original order.

    Scans for the pattern: an Experience-section H3 line followed by a date
    range ending in "Present". The employer is the leading segment of the
    H3 before " | " or comma. Falls back to all employers when no Present
    role is detected.
    """
    if not cv_text:
        return []
    lines = cv_text.split("\n")
    in_experience = False
    present: list[str] = []
    all_emps: list[str] = []
    seen_present: set[str] = set()
    seen_all: set[str] = set()

    # Walk: when we see an H3, capture the employer; look ahead a few lines
    # for a Present-tense date range; if found, mark as ongoing.
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("## "):
            heading = s[3:].strip().lower()
            in_experience = heading in (
                "experience", "work experience", "professional experience",
                "clinical experience",
            )
            continue
        if not in_experience:
            continue
        if s.startswith("### "):
            # Extract employer: split on " | " (the canonical H3 separator).
            # DON'T split on em-dash — "Uniting – The Marion" is a single
            # brand name with an internal em-dash that must be preserved.
            head = s[4:].strip()
            employer = head.split("|", 1)[0].split(",")[0].strip()
            if not employer or len(employer) < 4:
                continue
            # Look ahead up to 5 lines for a date range with "Present".
            is_present = False
            for j in range(i + 1, min(i + 6, len(lines))):
                if re.search(r"\b(?:Present|current|ongoing)\b", lines[j], re.IGNORECASE):
                    is_present = True
                    break
                if lines[j].strip().startswith(("### ", "## ")):
                    break
            if employer.lower() not in seen_all:
                seen_all.add(employer.lower())
                all_emps.append(employer)
            if is_present and employer.lower() not in seen_present:
                seen_present.add(employer.lower())
                present.append(employer)

    return present if present else all_emps


def _extract_cv_named_tools_for_summary(cv_text: str) -> list[str]:
    """Pull brand-name tools (BESTMed, MedMobile, ...) that appear in the
    original CV. Reuses _KNOWN_CV_TOOLS — same list the Skills surfacer uses."""
    if not cv_text:
        return []
    out: list[str] = []
    # Lazy import: _KNOWN_CV_TOOLS lives in _impl beside the Skills surfacer
    # that also reads it; importing at call time avoids an import cycle.
    from app.services.eval.writers._impl import _KNOWN_CV_TOOLS
    for pattern, canonical in _KNOWN_CV_TOOLS:
        if re.search(pattern, cv_text, re.IGNORECASE):
            if canonical not in out:
                out.append(canonical)
    return out


def _employer_block_text(cv_text: str, employer: str) -> str:
    """Extract the block of CV text scoped to one employer's Experience entry,
    i.e. from the H3 line naming the employer down to the next H3 or H2.

    Returns "" when the employer's section can't be located. Used to verify
    that a CV-named tool was ACTUALLY used at a specific employer before the
    S2 composer attributes it to them ("Currently delivering care at X using Y"
    is a FABRICATION when Y was used at a previous employer, not at X).
    """
    if not cv_text or not employer:
        return ""
    lines = cv_text.split("\n")
    # Distinctive employer tokens — match on the proper-noun parts only, so
    # the lookup survives the writer's heading rendering variations.
    emp_tokens = _distinctive_employer_tokens(employer)
    if not emp_tokens:
        # Fall back to whole-name substring if there's no distinctive token
        # (e.g. an org name made entirely of generic words). Conservative.
        emp_lower = employer.lower()
        for i, ln in enumerate(lines):
            if ln.strip().startswith("### ") and emp_lower in ln.lower():
                return _block_until_next_section(lines, i)
        return ""
    for i, ln in enumerate(lines):
        if not ln.strip().startswith("### "):
            continue
        head_lower = ln.lower()
        # H3 must contain at least one distinctive token of the employer.
        if any(re.search(r"\b" + re.escape(tok) + r"\b", head_lower)
               for tok in emp_tokens):
            return _block_until_next_section(lines, i)
    return ""


def _block_until_next_section(lines: list[str], start_idx: int) -> str:
    """Slice from `start_idx` until the next `###` or `##` heading."""
    out: list[str] = [lines[start_idx]]
    for ln in lines[start_idx + 1:]:
        s = ln.strip()
        if s.startswith("### ") or s.startswith("## "):
            break
        out.append(ln)
    return "\n".join(out)


def _tools_attributable_to_employer(
    cv_text: str, tailored_md: str, employer: str, all_tools: list[str],
) -> list[str]:
    """Return the subset of `all_tools` that appear inside `employer`'s block
    in either the original CV or the tailored markdown.

    Honest attribution: only name "X using TOOL" when the CV evidences that
    TOOL was used at X. If neither source has the tool in the employer's
    block, it stays OUT of the "using" clause (the tool may still be named
    elsewhere — Skills section, separate sentence — by other passes).
    """
    if not all_tools:
        return []
    md_block = _employer_block_text(tailored_md, employer)
    cv_block = _employer_block_text(cv_text, employer)
    if not md_block and not cv_block:
        return []
    blob = (md_block + "\n" + cv_block).lower()
    kept: list[str] = []
    for tool in all_tools:
        if re.search(r"\b" + re.escape(tool.lower()) + r"\b", blob):
            kept.append(tool)
    return kept


_EMPLOYER_GENERIC_TOKENS = {
    # Tokens that appear in many org names and therefore are NOT distinctive
    # enough on their own to mean "this employer is named". A standalone
    # 'Home' or 'Care' in S2 doesn't prove the employer is mentioned.
    "the", "and", "of", "for", "to", "at", "in", "on", "or",
    "care", "home", "house", "centre", "center", "facility", "facilities",
    "nursing", "aged", "village", "services", "service", "support",
    "hospital", "clinic", "community", "agency", "group", "company",
    "pty", "ltd", "inc", "limited", "co", "association",
}


def _distinctive_employer_tokens(employer: str) -> set[str]:
    """Return the distinctive (proper-noun) tokens of an employer name.

    'Uniting – The Marion' → {'uniting', 'marion'}
    'Jesmond Miranda Nursing Home' → {'jesmond', 'miranda'}
    'Anglicare Mildred Symons House' → {'anglicare', 'mildred', 'symons'}

    Generic CV-org words ('Nursing', 'Home', 'Care', 'Centre', 'The', ...)
    are filtered so they can't accidentally trigger a 'concrete' match.
    Tokens must be 4+ chars to ensure they're meaningful.
    """
    out: set[str] = set()
    for tok in re.split(r"[\s\-–—,/()]+", employer):
        tok = tok.strip().lower()
        if len(tok) < 4:
            continue
        if tok in _EMPLOYER_GENERIC_TOKENS:
            continue
        out.add(tok)
    return out


def _s2_has_concrete_evidence(s2: str, employer_names: list[str], cv_tools: list[str]) -> bool:
    """True if S2 contains an employer's DISTINCTIVE token or a numeric metric.

    NOTE: tool presence DOES NOT count as concrete evidence. The composition
    prompt explicitly forbids naming tools in S2 ("NO TOOL NAMES in S2 —
    tools live in the Skills section"). If the AI ignores that rule and
    emits a tool-named S2 like "...using BESTMed and MedMobile...", we
    treat it as NOT concrete so ``enforce_summary_concreteness`` rebuilds
    it via ``_compose_concrete_s2`` into a brief employer-anchored
    sentence. The cv_tools parameter is retained for signature stability
    (callers still pass it) but no longer counts toward concreteness.

    Partial matching (distinctive tokens) catches cases where the LLM cited
    only the brand suffix — e.g. 'The Marion' (fragment of 'Uniting – The
    Marion') correctly counts as employer-named via the 'marion' token.
    Exact-string substring matching would have missed this and replaced
    valid content with a template.
    """
    del cv_tools  # intentionally ignored; see docstring
    if not s2:
        return False
    low = s2.lower()
    for emp in employer_names:
        # Whole-name exact substring match (cheap, common case).
        if emp.lower() in low:
            return True
        # Distinctive-token match: at least one proper-noun token from the
        # employer name appears as a whole word in S2.
        for tok in _distinctive_employer_tokens(emp):
            if re.search(r"\b" + re.escape(tok) + r"\b", low):
                return True
    if _METRIC_TOKEN_RE.search(s2):
        return True
    return False


def _compose_concrete_s2(employer_names: list[str], cv_tools: list[str]) -> str:
    """Build a deterministic S2 from Present-employer names.

    Per the composition prompt's "NO TOOL NAMES in S2" rule, tools are
    deliberately NOT named here — naming BESTMed/MedMobile in S2 was the
    source of the universally-canned "Currently delivering care at X using
    BESTMed and MedMobile" sentence that read identical across many CVs.
    Tools live in the Skills section; this template anchors S2 on the
    employer only and stays brief.

    Templates:
      • 2+ employers → "Recent experience at [Emp1] and [Emp2]."
      • 1  employer  → "Recent experience at [Emp1]."
      • 0  employers → "" (caller leaves S2 untouched)

    The cv_tools parameter is kept for signature stability (callers pass
    attributable_tools); it is intentionally unused.
    """
    del cv_tools  # intentionally unused; see docstring
    if not employer_names:
        return ""
    emps = employer_names[:2]
    emp_clause = emps[0] if len(emps) == 1 else f"{emps[0]} and {emps[1]}"
    return f"Recent experience at {emp_clause}."


def enforce_summary_concreteness(markdown: str, original_cv_text: str) -> str:
    """Sprint E: replace a generic Professional Summary S2 with a deterministic
    employer/tool-naming sentence built from the original CV.

    'Generic' means S2 contains NO employer name from Experience, NO CV-named
    brand tool, AND NO numeric metric. When that's true, the S2 is wasted
    surface — the writer is filling space without selling. Replacing it is
    safe because:
      • S1 (the role-identity sentence) is preserved unchanged.
      • The replacement only names content the original CV literally evidences.
      • Idempotent: if S2 is already concrete, no change.

    No-op when:
      • No Summary section present.
      • Less than 2 sentences in the Summary.
      • S2 already has at least one concrete token.
      • No Present-role employers can be extracted from the CV.
    """
    if not markdown or not original_cv_text:
        return markdown
    lines = markdown.split("\n")
    bounds = _find_summary_section(lines)
    if not bounds:
        return markdown
    start, end = bounds
    prose, prose_idx = _extract_summary_prose(lines, start, end)
    if not prose:
        return markdown
    sentences = [s.strip() for s in _SENT_END_RE.split(prose) if s.strip()]
    if len(sentences) < 2:
        return markdown

    s1, s2 = sentences[0], sentences[1]
    rest = sentences[2:] if len(sentences) > 2 else []

    # Prefer the tailored markdown for employer extraction — it has the
    # canonical ## Experience / ### Employer structure that Sprint B
    # enforces, so parsing is reliable. Fall back to the raw cv_text if
    # the markdown for any reason yields nothing (defensive — should not
    # happen in production).
    employers = _extract_present_employers_from_experience(markdown)
    if not employers:
        employers = _extract_present_employers_from_experience(original_cv_text)
    # Tools: combine matches from BOTH the markdown and the original CV
    # text. Some brand mentions only survive in one source.
    tools_md = _extract_cv_named_tools_for_summary(markdown)
    tools_cv = _extract_cv_named_tools_for_summary(original_cv_text)
    # Preserve order, dedupe.
    seen: set[str] = set()
    tools: list[str] = []
    for t in tools_md + tools_cv:
        if t.lower() not in seen:
            seen.add(t.lower())
            tools.append(t)

    if _s2_has_concrete_evidence(s2, employers, tools):
        return markdown  # already concrete

    # Honest tool attribution — only attribute tools to an employer when the
    # CV actually evidences that connection. Without this guard, a candidate
    # whose tools were used at PreviousEmployer gets the fabricated S2
    # "Currently delivering care at CurrentEmployer using TOOL1 and TOOL2"
    # because the composer blindly conflates "most recent employer" with
    # "all CV tools". The reporting candidate (and recruiters who check)
    # will notice this immediately.
    attributable_tools: list[str] = []
    if employers and tools:
        attributable_tools = _tools_attributable_to_employer(
            original_cv_text, markdown, employers[0], tools,
        )
        # When there are 2 employers in the clause, include tools attributable
        # to EITHER (the AND clause covers both — keeps the OR semantically
        # correct).
        if len(employers) > 1:
            also = _tools_attributable_to_employer(
                original_cv_text, markdown, employers[1], tools,
            )
            for t in also:
                if t not in attributable_tools:
                    attributable_tools.append(t)

    new_s2 = _compose_concrete_s2(employers, attributable_tools)
    if not new_s2:
        return markdown  # no employers to name → leave S2 as is

    # Compose new prose: S1 + new_s2 + any trailing sentences (rare).
    new_prose = " ".join([s1, new_s2] + rest).strip()
    # Emit on the first prose line; blank the others to avoid leftovers.
    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose

    logger.info(
        "sprint-E summary S2 enforcer: replaced generic S2 with deterministic '%s'",
        new_s2,
    )
    return "\n".join(lines)
