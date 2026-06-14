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
from typing import List, Optional, Set

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
    """True if S2 contains an employer's DISTINCTIVE token, a CV-named tool,
    or a numeric metric.

    Partial matching (distinctive tokens) catches cases where the LLM cited
    only the brand suffix — e.g. 'The Marion' (fragment of 'Uniting – The
    Marion') correctly counts as employer-named via the 'marion' token.
    Exact-string substring matching would have missed this and replaced
    valid content with a template.

    Note on tools: the composition prompt forbids naming tools in S2 (NO TOOL
    NAMES IN S2 rule), but if the AI emits a tool-named S2 we DO NOT force a
    rebuild — the AI's sentence is informative and almost always preserves
    the prompt's 10-22 word S2 floor, whereas the deterministic rebuild
    produces a 4-word stub. The tool-naming rule is now enforced upstream by
    the CANNED-SHAPE BAN prompt block; this function's only job is to detect
    GENERIC S2 ('provides safe care to elderly residents') with no anchoring
    signal at all.
    """
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
    for tool in cv_tools:
        if tool.lower() in low:
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


def _norm_employer_name(name: str) -> str:
    """Lower-case, collapse internal whitespace — matches honesty_guard's
    employer-key normalisation so names parsed from cv_text line up with
    names extracted from the tailored markdown."""
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def _s2_names_any_employer(s2: str, employer_names: list[str]) -> bool:
    """True when S2 names ANY of ``employer_names`` (whole-name substring or a
    distinctive proper-noun token). Metric/tool-free on purpose: this answers
    'does S2 mention one of THESE specific employers?', used to detect an
    OFF-vertical employer leaking into the summary even when an on-vertical one
    co-occurs (which the generic concreteness check would mask)."""
    if not s2:
        return False
    low = s2.lower()
    for emp in employer_names:
        if emp.lower() in low:
            return True
        for tok in _distinctive_employer_tokens(emp):
            if re.search(r"\b" + re.escape(tok) + r"\b", low):
                return True
    return False


def _select_on_vertical_employers(
    employers: list[str],
    original_cv_text: str,
    vertical: str,
    jd_analysis: Optional[dict],
    limit: int = 2,
) -> tuple[list[str], list[str]]:
    """Split ``employers`` into (on-vertical, off-vertical) using the same
    ``ExperienceEntry.primary_vertical`` signal that ``filter_irrelevant_roles_pre``
    relies on. The summary may name AT MOST ``limit`` on-vertical employers; when
    more exist they are ranked by JD relevance (overlap of the entry's role+bullets
    with the JD vocabulary), recency preserved as the tie-break.

    An employer the parser can't classify (``primary_vertical is None``, e.g. an
    accounting role with no nursing/tech/cleaning lexicon hits) is treated as
    off-vertical — we only NAME experience we can positively tie to the JD's
    vertical. Returns (on_vertical_names[:limit], off_vertical_names)."""
    from app.services.cv.experience_parser import parse_cv_experience

    by_norm: dict[str, tuple[Optional[str], str]] = {}
    for e in parse_cv_experience(original_cv_text):
        if e.employer:
            # Strip the same "| Location" / ", Location" suffix that
            # _extract_present_employers_from_experience strips, so the parser's
            # employer key lines up with the extracted name we look up by.
            emp_key = e.employer.split("|", 1)[0].split(",")[0].strip()
            entry_text = " ".join([e.role or "", *(e.bullets or [])])
            by_norm[_norm_employer_name(emp_key)] = (e.primary_vertical, entry_text)

    on_vertical: list[tuple[str, str]] = []   # (employer, entry_text)
    off_vertical: list[str] = []
    for emp in employers:
        pv, entry_text = by_norm.get(_norm_employer_name(emp), (None, ""))
        if pv is not None and pv == vertical:
            on_vertical.append((emp, entry_text))
        else:
            off_vertical.append(emp)

    if len(on_vertical) > limit and jd_analysis:
        from app.services.eval.enforce_w3 import _jd_vocab
        vocab = _jd_vocab(jd_analysis)

        def _relevance(item: tuple[str, str]) -> int:
            toks = set(re.findall(r"[a-z0-9]{4,}", item[1].lower()))
            return len(toks & vocab)

        # Stable sort keeps original (recency) order for equal-relevance ties.
        on_vertical = sorted(on_vertical, key=_relevance, reverse=True)

    return [emp for emp, _ in on_vertical[:limit]], off_vertical


# ---------------------------------------------------------------------------
# Part B — deterministic JD-anchored S2 fallback for zero-on-vertical CVs.
#
# When the candidate has NO on-vertical experience (pure career-changer),
# Part A can't name an employer. Part B scans the CV for JD-relevant
# certifications, education, clinical placements, or volunteer work and
# builds a short anchoring sentence from the best evidence. No LLM call.
# ---------------------------------------------------------------------------

_CERT_SECTION_RE = re.compile(
    r"^(?:#+\s*)?(certif|licen|credentials|accreditation|clinical placement|placements)",
    re.IGNORECASE,
)
_EDUCATION_SECTION_RE = re.compile(
    r"^(?:#+\s*)?(education|qualifications|academic)",
    re.IGNORECASE,
)
_VOLUNTEER_SECTION_RE = re.compile(
    r"^(?:#+\s*)?(volunteer|community service|extracurricular|projects)",
    re.IGNORECASE,
)


def _extract_section_lines(cv_text: str, heading_re: re.Pattern) -> List[str]:
    """Return non-blank content lines under the FIRST section whose heading
    matches ``heading_re``, stopping at the next heading of equal or higher rank."""
    lines = cv_text.split("\n")
    capture: List[str] = []
    capturing = False
    heading_level = 0
    for ln in lines:
        stripped = ln.strip()
        # Detect headings: markdown (## / ###) or plain-text ALL-CAPS.
        is_heading = False
        level = 0
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            is_heading = True
        elif stripped.isupper() and 3 <= len(stripped) <= 60:
            level = 2  # treat all-caps as H2
            is_heading = True
        if is_heading:
            if capturing:
                if level <= heading_level:
                    break
                # Sub-heading inside the section — continue capturing.
            elif heading_re.search(stripped.lstrip("#").strip()):
                capturing = True
                heading_level = level
                continue
        if capturing and stripped:
            capture.append(stripped)
    return capture


def _pick_jd_relevant_evidence(
    cv_text: str, jd_vocab: Set[str],
) -> Optional[str]:
    """Find the single best JD-relevant anchor from non-Experience sections.

    Returns a short phrase like "Certificate IV in Ageing Support" or
    "120-hour clinical placement in residential aged care", or None."""
    # Priority: certifications/placements > education > volunteer/projects.
    for heading_re in (_CERT_SECTION_RE, _EDUCATION_SECTION_RE, _VOLUNTEER_SECTION_RE):
        section_lines = _extract_section_lines(cv_text, heading_re)
        if not section_lines:
            continue
        # Score each line by JD vocab overlap — pick the best.
        best_line, best_score = "", 0
        for ln in section_lines:
            toks = set(re.findall(r"[a-z0-9]{4,}", ln.lower()))
            score = len(toks & jd_vocab)
            if score > best_score:
                best_score = score
                best_line = ln
        if best_score >= 1:
            # Clean the line: strip bullet markers, trailing dates, and locations.
            clean = re.sub(r"^[-•*]\s*", "", best_line).strip()
            clean = re.sub(r"\s*\|.*$", "", clean).strip()
            # Strip trailing date phrases like "April 2026" or "Jul 2025 – Present"
            clean = re.sub(
                r"\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*"
                r"\s+\d{4}(?:\s*[–—-]\s*(?:Present|\w+\s+\d{4}))?\s*$",
                "", clean, flags=re.IGNORECASE,
            ).strip()
            # Strip AU VET unit codes (CHC43015, HLTHPS007) — they belong in
            # the credentials line, not a summary sentence.
            clean = re.sub(
                r"\s*\((?:HLT|CHC|BSB|FSK|SIT|CPP|AHC)[A-Z0-9]{2,6}\)",
                "", clean, flags=re.IGNORECASE,
            )
            clean = re.sub(
                r"\b(?:HLT|CHC|BSB|FSK|SIT|CPP|AHC)[A-Z0-9]{2,6}\s*",
                "", clean, flags=re.IGNORECASE,
            ).strip()
            # Cap length — we want a phrase, not a paragraph.
            if len(clean) > 120:
                clean = clean[:117].rsplit(" ", 1)[0] + "…"
            return clean
    return None


def _strip_employer_from_s2(s2: str, off_vertical: List[str]) -> str:
    """Remove off-vertical employer references from S2 text, collapsing the
    surrounding "Recent experience at X and Y." pattern to either the on-vertical
    employer or an empty string."""
    result = s2
    for emp in off_vertical:
        # "X and Emp." or "Emp and X." patterns
        result = re.sub(
            r"\s+and\s+" + re.escape(emp), "", result, flags=re.IGNORECASE,
        )
        result = re.sub(
            re.escape(emp) + r"\s+and\s+", "", result, flags=re.IGNORECASE,
        )
        # Bare "at Emp." or standalone reference
        result = re.sub(re.escape(emp), "", result, flags=re.IGNORECASE)
    # Collapse "Recent experience at ." → ""
    result = re.sub(r"Recent experience at\s*\.\s*$", "", result, flags=re.IGNORECASE)
    result = re.sub(r"\s{2,}", " ", result).strip()
    return result


def _compose_part_b_s2(
    s2: str, off_vertical: List[str], original_cv_text: str,
    jd_analysis: Optional[dict],
) -> str:
    """Part B fallback: build a JD-oriented S2 for zero-on-vertical CVs.

    Strategy:
    1. Try to find JD-relevant evidence from certs/education/projects/volunteer.
       If found → "Holds a <evidence>." or "Completed <evidence>."
    2. If nothing JD-relevant → strip the off-vertical employer from the AI's S2
       and return whatever remains (may be empty → caller keeps original).
    """
    from app.services.eval.enforce_w3 import _jd_vocab
    vocab = _jd_vocab(jd_analysis or {})

    evidence = _pick_jd_relevant_evidence(original_cv_text, vocab) if vocab else None

    if evidence:
        # Build a grounded sentence from real CV content.
        low = evidence.lower()
        if any(w in low for w in ("certificate", "cert ", "diploma", "licence", "license")):
            return f"Holds a {evidence}."
        if any(w in low for w in ("placement", "practicum", "internship", "clinical")):
            return f"Completed {evidence}."
        return f"Background includes {evidence}."

    # No JD-relevant non-Experience evidence found. Strip the off-vertical
    # employer from the AI's S2 and return what's left.
    stripped = _strip_employer_from_s2(s2, off_vertical)
    return stripped if stripped and len(stripped.split()) >= 4 else ""


def enforce_summary_concreteness(
    markdown: str,
    original_cv_text: str,
    vertical: Optional[str] = None,
    jd_analysis: Optional[dict] = None,
) -> str:
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

    # On-vertical scoping (Part A). The Experience SECTION legitimately keeps
    # off-vertical roles (filter_irrelevant_roles_pre honours a 2-role floor so
    # a thin CV isn't gutted), but the summary's "Recent experience at …" line
    # must NOT bill an off-vertical employer as relevant — e.g. a "Junior
    # Accountant at Akala Motors" surfacing in an aged-care AIN summary. Drop
    # off-vertical employers from the naming set and cap on-vertical naming at 2
    # (JD-ranked when more exist). No-op when `vertical` is None (legacy
    # behaviour / non-W3 callers): name_set == employers, off_vertical empty.
    if vertical:
        name_set, off_vertical = _select_on_vertical_employers(
            employers, original_cv_text, vertical, jd_analysis,
        )
    else:
        name_set, off_vertical = employers, []

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

    # Force a rebuild when S2 NAMES an off-vertical employer — even if it also
    # names an on-vertical one (the plain concreteness check would see the
    # on-vertical name and wrongly conclude "already concrete", leaving the
    # off-vertical leak in place).
    s2_leaks_off_vertical = bool(off_vertical) and _s2_names_any_employer(s2, off_vertical)
    if _s2_has_concrete_evidence(s2, name_set, tools) and not s2_leaks_off_vertical:
        return markdown  # already concrete, no off-vertical leak

    # Honest tool attribution — only attribute tools to an employer when the
    # CV actually evidences that connection. Without this guard, a candidate
    # whose tools were used at PreviousEmployer gets the fabricated S2
    # "Currently delivering care at CurrentEmployer using TOOL1 and TOOL2"
    # because the composer blindly conflates "most recent employer" with
    # "all CV tools". The reporting candidate (and recruiters who check)
    # will notice this immediately.
    attributable_tools: list[str] = []
    if name_set and tools:
        attributable_tools = _tools_attributable_to_employer(
            original_cv_text, markdown, name_set[0], tools,
        )
        # When there are 2 employers in the clause, include tools attributable
        # to EITHER (the AND clause covers both — keeps the OR semantically
        # correct).
        if len(name_set) > 1:
            also = _tools_attributable_to_employer(
                original_cv_text, markdown, name_set[1], tools,
            )
            for t in also:
                if t not in attributable_tools:
                    attributable_tools.append(t)

    new_s2 = _compose_concrete_s2(name_set, attributable_tools)
    if not new_s2:
        # Part B: no on-vertical employer to name. Build a JD-anchored S2 from
        # certifications, education, placements, or volunteer work. If nothing
        # JD-relevant is found, strip the off-vertical reference and keep what
        # remains. Never inject an off-vertical employer into the summary.
        if s2_leaks_off_vertical:
            fallback_s2 = _compose_part_b_s2(
                s2, off_vertical, original_cv_text, jd_analysis,
            )
            if fallback_s2:
                new_prose = " ".join([s1, fallback_s2] + rest).strip()
                for i in prose_idx:
                    lines[i] = ""
                lines[prose_idx[0]] = new_prose
                logger.info(
                    "summary S2 (Part B): zero on-vertical employers — replaced "
                    "off-vertical S2 with JD-anchored fallback '%s'",
                    fallback_s2,
                )
                return "\n".join(lines)
            logger.info(
                "summary S2 (Part B): no JD-relevant evidence found to replace "
                "off-vertical S2; leaving unchanged. off_vertical=%s",
                off_vertical,
            )
        return markdown

    # Compose new prose: S1 + new_s2 + any trailing sentences (rare).
    new_prose = " ".join([s1, new_s2] + rest).strip()

    # ANTI-GUT GUARD (Opal Healthcare regression, 2026-06-12): the rebuild
    # exists to ADD concreteness, not to shrink the summary. With only ONE
    # present employer and no attributable tools, _compose_concrete_s2 produces
    # a 4-word stub ("Recent experience at Uniting."). When the AI's original S2
    # is a SUBSTANTIAL sentence, replacing it with that stub guts the summary
    # below the prompt's 35-word floor and reads as a placeholder.
    #
    # Guard precisely. Skip the rebuild ONLY when ALL hold:
    #   • single employer (the stub case — a 2-employer rebuild names both
    #     roles and is substantive, so it's exempt: that's the intended
    #     Sprint-E behaviour and the test_awkward_double_and_s2_replaced case);
    #   • the AI's ORIGINAL S2 is itself a real sentence (>= 10 words) worth
    #     keeping — a thin generic filler S2 (< 10 words) is NOT worth
    #     protecting, so the concrete employer rebuild fires for it (that's the
    #     honesty-fix test: 'Provides safe, respectful support for older
    #     people.' -> 'Recent experience at Uniting.');
    #   • the rebuild actually shortens the summary.
    _WORD_FLOOR = 35  # noqa: F841 — documents the prompt floor this guard protects
    s2_words = len(s2.split())
    old_words = len(prose.split())
    new_words = len(new_prose.split())
    # The anti-gut guard protects an HONEST substantial S2 from being replaced
    # by a thin stub. It must NOT protect an S2 whose substance comes from an
    # off-vertical employer leak — gutting that is exactly the fix we want.
    if (
        not s2_leaks_off_vertical
        and len(name_set) < 2
        and s2_words >= 10
        and new_words < old_words
    ):
        logger.info(
            "sprint-E summary S2 enforcer: SKIPPED rebuild — single-employer "
            "stub would gut a substantial %d-word S2 (summary %d→%d words); "
            "keeping AI's original S2.",
            s2_words, old_words, new_words,
        )
        return markdown

    # Emit on the first prose line; blank the others to avoid leftovers.
    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose

    logger.info(
        "sprint-E summary S2 enforcer: replaced generic S2 with deterministic '%s'",
        new_s2,
    )
    return "\n".join(lines)
