"""Summary-quality deterministic enforcers (opener, title case, word caps).

Split out of the former single-module tailored_cv.py (1,558 lines). Pure code
motion — function bodies, ordering and comments are unchanged. Every public
*and* private name remains importable from
``app.services.pipeline.steps.tailored_cv`` via the package __init__: 16 of
the 17 names imported elsewhere are underscore-prefixed, so the 'private'
API is de-facto public (eval/writers/injection.py and _impl.py depend on it).
"""
from __future__ import annotations

import re
from .text import _trim_to_words

# ---------------------------------------------------------------------------
# Summary-quality deterministic enforcers
# ---------------------------------------------------------------------------

# Role-title fragments that appear at the start of the summary S1 opener and
# must be Title Cased.  We don't try to title-case the whole sentence (that
# would wreck mid-sentence proper nouns); we only fix the opener token(s)
# that are the role title — typically 2-4 words before the first "with".
_TITLE_CASE_STOP = re.compile(
    r"^([A-Za-z][a-z]*(?: [A-Za-z][a-z]*){0,4})\b(.*)",
    re.DOTALL,
)

# Vague anchor phrases the COMPANY ANCHOR rule explicitly forbids.
# Real anchors are: a NAMED employer ("at RFBI Concord Community Village") or
# a scope phrase ("across multiple residential aged care settings"). Anything
# vague — "a facility", "this setting", "a multidisciplinary team
# environment" — fails the rule.
_VAGUE_ANCHOR_RE = re.compile(
    # facility variants
    r"\b(?:at|in|through)\s+(?:a|an|the)\s+(?:aged care\s+)?facilit(?:y|ies)\b"
    # setting variants — "in a residential aged care setting", "in this setting"
    r"|\b(?:at|in|for residents in|across)\s+(?:a|an|the|this|that|the same)"
    r"(?:\s+(?:residential|aged care|nursing|care|clinical))*\s+setting\b"
    # environment variants — "in a multidisciplinary team environment"
    r"|\b(?:at|in|within)\s+(?:a|an|the|this|that)"
    r"(?:\s+[a-z-]+){0,4}\s+environment\b"
    # generic placement / casual / industry catch-alls
    r"|\bin\s+(?:casual|various|several|multiple)\s+roles?\b"
    r"|\bduring (?:my )?placement\b"
    r"|\bacross the industry\b"
    # "in aged care" / "for residents" with no specific anchor following
    r"|\bin aged care\b(?!\s+(?:at|with|across))"
    r"|\bfor residents\b(?!\s+(?:at|across|of [A-Z]))",
    re.IGNORECASE,
)


def _get_summary_prose(lines: list[str], start: int, end: int) -> tuple[list[int], str]:
    """Return (prose_line_indices, joined_prose_text) for a summary block."""
    idx, texts = [], []
    for i, ln in enumerate(lines[start + 1: end], start=start + 1):
        s = ln.strip()
        if s and not s.startswith(("-", "*")):
            idx.append(i)
            texts.append(s)
    return idx, " ".join(texts)


# C22f: tolerate a trailing colon the AI writer sometimes emits ("## Career
# Highlights:") — the original `$`-anchored pattern was defeated by it,
# silently skipping this whole summary block for every downstream pass that
# reads through _find_summary_block.
_SUMMARY_HEADING_RE = re.compile(r"^## (Career Highlights|Professional Summary|Summary):?$")


def _find_summary_block(lines: list[str]) -> tuple[int, int] | tuple[None, None]:
    start = next((i for i, ln in enumerate(lines) if _SUMMARY_HEADING_RE.match(ln.strip())), None)
    if start is None:
        return None, None
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return start, end


def _title_case_role(title_part: str) -> str:
    """Title-case a role title, leaving small connector words lowercase
    (e.g. "Assistant in Nursing", not "Assistant In Nursing"). The first word
    is always capitalised."""
    small = {"in", "of", "the", "and", "for", "to", "a", "an", "on", "at", "with", "&"}
    words = title_part.split()
    out: list[str] = []
    for i, w in enumerate(words):
        if i != 0 and w.lower() in small:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:] if w else w)
    return " ".join(out)


def _enforce_summary_s1_title_case(markdown: str) -> str:
    """Title-case the role-title opener of S1 (words before the first 'with'
    or comma that form the job title).  Fixes "Personal care worker with …"
    → "Personal Care Worker with …"."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown
    # Split into S1 / rest on first period
    dot = prose.find(".")
    if dot == -1:
        return markdown
    s1, rest = prose[:dot + 1], prose[dot + 1:]
    # Find the role-title token: words up to (but not including) "with" / "–" / ","
    # Capture trailing whitespace separately so we don't lose the space.
    with_match = re.match(r"^(.*?)(\s+)(with|–|-|,)\b", s1, re.IGNORECASE)
    if with_match:
        title_part = with_match.group(1)
        space = with_match.group(2)
        remainder = s1[len(title_part) + len(space):]
        fixed_title = _title_case_role(title_part)
        new_s1 = fixed_title + space + remainder
    else:
        # Fallback: title-case first 4 words
        words = s1.split()
        words[:4] = _title_case_role(" ".join(words[:4])).split()
        new_s1 = " ".join(words)
    new_prose = new_s1 + rest
    # Write back into the first prose line
    lines[idx[0]] = new_prose
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


def _enforce_summary_s2_word_cap(markdown: str, cap: int = 22) -> str:
    """Hard-trim S2 to at most `cap` words (rule: Sentence 2 ≤22 words)."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown
    sent_re = re.compile(r"(?<=[.!?])\s+")
    sentences = [s.strip() for s in sent_re.split(prose) if s.strip()]
    if len(sentences) < 2:
        return markdown
    s2 = sentences[1]
    if len(s2.split()) <= cap:
        return markdown
    s2 = _trim_to_words(s2, cap)
    new_prose = sentences[0] + " " + s2
    lines[idx[0]] = new_prose
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


# Generic clinical / care competencies that the LLM sometimes Title-Cases in
# the summary (e.g. "Activities of Daily Living", "Dementia Care"). None are
# proper nouns, so mid-sentence they read wrong in Title Case. We force the
# canonical lowercase form, then re-capitalise only if the phrase happens to
# open a sentence. Curated allowlist keeps this safe — we never touch real
# proper nouns (employer names, branded systems, place names).
_GENERIC_CARE_PHRASES = [
    "activities of daily living",
    "electronic medication administration",
    "medication administration",
    "medication assistance",
    "person-centred care",
    "person-centered care",
    "personal care",
    "dementia care",
    "palliative care",
    "behavioural management techniques",
    "behavioral management techniques",
    "behavioural management",
    "behavioral management",
    "behaviour support planning",
    "manual handling",
    "infection control",
    "incident reporting",
    "multidisciplinary teams",
    "multidisciplinary team",
    "electronic health records",
    "clinical documentation",
    "accurate documentation",
]
_GENERIC_CARE_RE = re.compile(
    r"(?<![A-Za-z])(" + "|".join(re.escape(p) for p in _GENERIC_CARE_PHRASES) + r")(?![A-Za-z])",
    re.IGNORECASE,
)


def _lowercase_generic_care_phrases(markdown: str) -> str:
    """Force curated generic care phrases to lowercase inside the summary block,
    re-capitalising only when a phrase opens a sentence. Fixes the LLM's habit
    of writing "specialising in Activities of Daily Living" mid-sentence."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown

    def _repl(m: re.Match) -> str:
        phrase = m.group(1).lower()
        # Re-capitalise if this phrase opens a sentence (start of prose, or
        # preceded by sentence-ending punctuation + space).
        i = m.start()
        preceding = prose[:i].rstrip()
        if not preceding or preceding[-1] in ".!?":
            return phrase[:1].upper() + phrase[1:]
        return phrase

    fixed = _GENERIC_CARE_RE.sub(_repl, prose)
    if fixed == prose:
        return markdown
    lines[idx[0]] = fixed
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


def _flag_vague_anchor(markdown: str) -> str:
    """Replace vague COMPANY ANCHOR phrases with a conspicuous placeholder so
    the issue is visible in the rendered output and triggers a retry in review.
    Does NOT attempt an AI rewrite — that belongs to the retry loop."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx or not _VAGUE_ANCHOR_RE.search(prose):
        return markdown
    fixed = _VAGUE_ANCHOR_RE.sub("[ANCHOR NEEDED]", prose)
    lines[idx[0]] = fixed
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)


# Status / education / identity labels the S1 opener must NEVER lead with — the
# opener slot is for the JD-aligned PROFESSIONAL identity only (composition.py
# CAREER HIGHLIGHTS + tailored_cv.py CRITICAL RULE #1). "Aspiring" is
# deliberately NOT here: W1 permits "Aspiring <Role>" for true career-changers
# with zero in-vertical experience, so the enforcer leaves it alone.
_FORBIDDEN_OPENER_RE = re.compile(
    r"^\s*(?:an?\s+)?(?:"
    r"international\s+student|international|"
    r"recent\s+graduate|recent|graduate|"
    r"visa\s+holder|career\s+changer|student|"
    r"certificate|diploma|bachelor|masters?|phd|doctorate"
    r")\b",
    re.IGNORECASE,
)

# Leading seniority adjectives stripped from the JD title before it is used as
# the opener — the SENIORITY WORDS rule forbids a seniority label unless it
# appears in the candidate's own CV titles, and the enforcer cannot verify that.
_SENIORITY_PREFIX_RE = re.compile(
    r"^(?:senior|junior|lead|principal|staff|entry[-\s]level|trainee)\s+",
    re.IGNORECASE,
)


def _clean_job_title(jd_job_title: str) -> str:
    """Sanitise a JD job title for use as the summary opener: drop parenthetical
    abbreviations, a leading seniority adjective, and surplus whitespace. Returns
    "" when nothing usable remains (caller then flags instead of inserting)."""
    if not jd_job_title:
        return ""
    title = re.sub(r"\s*\([^)]*\)", "", jd_job_title)        # drop "(AIN)" etc.
    title = re.sub(r"\s+", " ", title).strip(" -–|,")
    title = _SENIORITY_PREFIX_RE.sub("", title).strip()
    # Guard against junk titles (empty, or an implausibly long phrase that is
    # clearly not a clean role label).
    if not title or len(title.split()) > 6:
        return ""
    return title


def _norm_opener_title(s: str) -> str:
    """Lowercase, drop a trailing '(...)' abbrev, collapse whitespace and trim
    trailing punctuation — so an opener can be compared to the JD title."""
    s = re.sub(r"\s*\([^)]*\)", "", s or "")
    return re.sub(r"\s+", " ", s).strip().lower().rstrip(".,")


def _enforce_summary_opener(
    markdown: str, jd_job_title: str = "", *, title_supported: bool = True
) -> str:
    """Fix the S1 opener role-title slot. Two trigger conditions:

      1. The opener is a forbidden status / education / identity label
         ("International student", "Recent graduate", …).
      2. The opener IS the JD job title but the candidate's CV does NOT support
         that title (``title_supported=False``) — e.g. a "Pharmacy Technician"
         opener on an aged-care CV. The composer (or pass 1) can insert this to
         force JD alignment; it fabricates an identity the CV can't back.

    Replacement rule: use the JD job title ONLY when it is CV-supported. When it
    is NOT supported (or unavailable), flag ``[ROLE TITLE NEEDED]`` so the
    failure is conspicuous — never fabricate a title to make the CV "align".

    ``title_supported`` should be set by the caller from a domain / role-family
    comparison of the JD vs the candidate's CV. Defaults True for back-compat
    with callers that have no CV context (they keep the prior behaviour).

    Runs AFTER _enforce_summary_s1_title_case so an inserted title keeps the
    JD's own casing (e.g. "Assistant in Nursing", not "Assistant In Nursing")."""
    lines = markdown.split("\n")
    start, end = _find_summary_block(lines)
    if start is None:
        return markdown
    idx, prose = _get_summary_prose(lines, start, end)
    if not prose or not idx:
        return markdown
    dot = prose.find(".")
    s1 = prose if dot == -1 else prose[: dot + 1]
    rest = "" if dot == -1 else prose[dot + 1:]
    # Split the opener (role-title slot) from the rest of S1 at the first
    # "with"/"having"/dash/comma boundary — matching the "<Role> with …" shape.
    split = re.match(
        r"^(.*?)(\s+(?:with|having|–|-|,)\b.*)$", s1, re.IGNORECASE | re.DOTALL
    )
    opener = split.group(1) if split else s1
    opener_clean = opener.strip()
    jd_title = _clean_job_title(jd_job_title)

    forbidden = bool(_FORBIDDEN_OPENER_RE.match(opener_clean))
    # Off-axis JD title inserted into the opener despite no CV support.
    fabricated_jd_title = (
        not title_supported
        and bool(jd_title)
        and _norm_opener_title(opener_clean) == _norm_opener_title(jd_title)
    )
    if not (forbidden or fabricated_jd_title):
        return markdown

    # Use the JD title ONLY when the CV supports it; otherwise flag rather than
    # fabricate a title to force alignment.
    replacement = jd_title if (jd_title and title_supported) else "[ROLE TITLE NEEDED]"
    if split:
        new_s1 = replacement + split.group(2)
    elif forbidden:
        # No "with"-style tail: swap only the leading forbidden phrase.
        new_s1 = _FORBIDDEN_OPENER_RE.sub(replacement, s1, count=1)
    else:
        # Fabricated-title case with no tail boundary: replace the opener span.
        new_s1 = replacement + s1[len(opener):]
    lines[idx[0]] = new_s1 + rest
    for i in idx[1:]:
        lines[i] = ""
    return "\n".join(lines)
