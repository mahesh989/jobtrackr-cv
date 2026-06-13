"""
Deterministic W3 gates — the rules that kept failing as prompt *prose* across
W1/W2/W3 evals, moved into code (where they actually hold).

Each gate is a pure markdown→markdown transform, applied to the W3 output after
the production post-processors + skills hygiene. None of them invent content;
they only remove / clamp what the prompt was supposed to but didn't.

Gates:
  • suppress_ai_identity   — when the role family suppresses AND the JD has no
                             AI signal: strip "& AI Engineer"-style title
                             suffixes, remove AI/ML skills, drop AI-only
                             projects (keeping ≥1 project).
  • clamp_two_sentences    — Career Highlights / Summary → at most 2 sentences.
  • enforce_degree_relevance — drop graduate degrees with zero JD-vocab overlap;
                             always keep a Bachelor and ≥1 entry.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Set

from app.services.eval.enforce import _split_items, _norm
from app.services.eval.grounding import compute_grounding

# ---------------------------------------------------------------------------
# AI-signal detection (mirrors the prompt's scan)
# ---------------------------------------------------------------------------

_AI_SIGNALS = [
    "llm", "gpt", "claude", "multi-llm", "transformer", "rag", "embedding",
    "deep learning", "neural network", "computer vision", "nlp", "pytorch",
    "tensorflow", "scikit-learn", "ml model", "ai engineer", "ml engineer",
    "ai/ml", "machine learning", "model training", "fine-tuning", "mlops",
    "ml ops", "generative ai", "data scientist",
]


def jd_ai_signal_count(jd_text: str) -> int:
    low = (jd_text or "").lower()
    return sum(1 for sig in _AI_SIGNALS if sig in low)


def jd_has_ai_signal(jd_text: str, threshold: int = 2) -> bool:
    return jd_ai_signal_count(jd_text) >= threshold


# AI/ML tokens that, when present in the JD's OWN role title, mean the target
# role really is AI-forward — so the candidate's AI identity should lead. A
# plain title ("Data Analyst") must NOT keep an "& AI Engineer" tag even when
# the JD body name-drops ML, which is exactly what the body-only signal gate got
# wrong (a Data-Analyst JD mentioning "machine learning"/"data scientist" twice
# disabled all suppression, leaking the AI identity into the summary).
_AI_TITLE_TOKENS = (
    "ai", "ml", "a.i.", "artificial intelligence", "machine learning",
    "deep learning", "data scientist", "research scientist", "ml engineer",
    "ai engineer", "computer vision", "nlp", "mlops",
)


def jd_title_is_ai(jd_analysis: Dict[str, Any] | None) -> bool:
    title = str((jd_analysis or {}).get("job_title") or "").lower()
    if not title:
        return False
    return any(re.search(r"\b" + re.escape(t) + r"\b", title) for t in _AI_TITLE_TOKENS)


# ---------------------------------------------------------------------------
# Suppression
# ---------------------------------------------------------------------------

# Skill items to remove from the Skills section when suppressing.
_AI_SKILL_TOKENS: Set[str] = {
    "machine learning", "deep learning", "computer vision", "nlp",
    "natural language processing", "pytorch", "tensorflow", "scikit learn",
    "scikit-learn", "keras", "llm", "multi llm", "multi-llm", "neural networks",
    "neural network", "mlops", "ml ops", "generative ai", "transformers",
}

# Tokens that mark a project as AI-only (drop when suppressing, keeping ≥1).
_AI_PROJECT_TOKENS = [
    "yolo", "corrosion", "computer vision", "deep learning", "pytorch",
    "tensorflow", "heart attack", "edge ai", "map@", "map@50", "neural",
    "ml application", "scikit",
]

_TITLE_AI_SUFFIX_RE = re.compile(
    r"\s*(?:&|and)\s*(?:ai|ml|artificial intelligence|machine learning)\s+"
    r"(?:engineer|researcher|scientist|developer)\b",
    re.IGNORECASE,
)


def _section_bounds(lines: List[str], heading_pred) -> tuple[int, int] | None:
    start = next((i for i, ln in enumerate(lines) if heading_pred(ln.strip())), None)
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    return start, end


def _strip_title_ai_suffix(md: str) -> str:
    return "\n".join(_TITLE_AI_SUFFIX_RE.sub("", ln) for ln in md.split("\n"))


def _strip_ai_skills(md: str) -> str:
    lines = md.split("\n")
    bounds = _section_bounds(lines, lambda s: s.lower() == "## skills")
    if not bounds:
        return md
    start, end = bounds
    label_re = re.compile(r"^\s*\*\*([^*]+?):\*\*\s*(.*)$")
    for i in range(start + 1, end):
        m = label_re.match(lines[i])
        if not m:
            continue
        label, rest = m.group(1).strip(), m.group(2).strip()
        kept = [it for it in _split_items(rest) if _norm(it) not in _AI_SKILL_TOKENS]
        lines[i] = f"**{label}:** " + ", ".join(kept)
    return "\n".join(lines)


def _drop_ai_projects(md: str) -> str:
    lines = md.split("\n")
    bounds = _section_bounds(lines, lambda s: s.lower() == "## projects")
    if not bounds:
        return md
    start, end = bounds

    # Parse project entries: each starts at a '### ' line and runs to the next
    # '### ' or the section end.
    entry_starts = [i for i in range(start + 1, end) if lines[i].lstrip().startswith("### ")]
    if len(entry_starts) <= 1:
        return md  # never drop the only project

    entries: List[tuple[int, int]] = []
    for idx, s in enumerate(entry_starts):
        e = entry_starts[idx + 1] if idx + 1 < len(entry_starts) else end
        entries.append((s, e))

    def _is_ai_only(s: int, e: int) -> bool:
        # Look at the title + the immediate subtitle line (tools/status).
        blob = " ".join(lines[s:min(s + 2, e)]).lower()
        return any(tok in blob for tok in _AI_PROJECT_TOKENS)

    keep_flags = [not _is_ai_only(s, e) for (s, e) in entries]
    if not any(keep_flags):
        return md  # would empty the section — keep as-is
    if all(keep_flags):
        return md  # nothing to drop

    drop_idx = {i for i, k in enumerate(keep_flags) if not k}
    out: List[str] = lines[: start + 1]
    for idx, (s, e) in enumerate(entries):
        if idx in drop_idx:
            continue
        out.extend(lines[s:e])
    out.extend(lines[end:])
    return "\n".join(out)


def suppress_ai_identity(
    md: str, jd_text: str, jd_analysis: Dict[str, Any] | None = None,
) -> str:
    """Suppress the candidate's AI identity unless the JD is genuinely AI-forward.

    Two independent decisions, because they carry different risk:

    • Title-suffix strip ("& AI Engineer") — purely an identity tag, very low
      risk to remove. Driven by the JD's OWN role title: a plainly-titled role
      (e.g. "Data Analyst") should never carry an AI-engineer identity, even if
      the JD body mentions ML. Only kept when the TITLE itself is AI/ML.

    • Skill / project drops — aggressive (they remove real CV content), so they
      stay gated on the broader body signal AND a non-AI title: don't nuke ML
      skills/projects a partly-AI JD might genuinely value.
    """
    title_is_ai = jd_title_is_ai(jd_analysis)
    if not title_is_ai:
        md = _strip_title_ai_suffix(md)
    if not title_is_ai and not jd_has_ai_signal(jd_text):
        md = _strip_ai_skills(md)
        md = _drop_ai_projects(md)
    return md


# ---------------------------------------------------------------------------
# Summary lead-identity trim (field-agnostic) — the general replacement for the
# AI-only title-suffix strip. When the summary opens with a COMPOUND identity
# ("Data Analyst and AI Engineer with ..."), keep the conjunct(s) that match the
# JD's OWN job title and drop the off-axis one(s) — for ANY profession, ANY
# field (Project Coordinator & Software Developer, Registered Nurse & Data
# Analyst, etc.). Anchored on the JD title, so an AI-titled JD keeps "AI
# Engineer" automatically. Deterministic, adds nothing, and conservative: it
# acts only on a clear compound of full role titles.
# ---------------------------------------------------------------------------

# General profession head-nouns: the LAST word of a role title. Used only to
# decide whether a conjoined lead is two SEPARATE roles (trimmable) vs one
# multi-word role ("Data and Business Analyst" — not separable). Field-agnostic.
_ROLE_HEAD_NOUNS: Set[str] = {
    "engineer", "analyst", "manager", "developer", "scientist", "consultant",
    "specialist", "coordinator", "designer", "architect", "administrator",
    "officer", "worker", "assistant", "lead", "director", "accountant",
    "technician", "nurse", "teacher", "programmer", "strategist", "planner",
    "supervisor", "operator", "clerk", "advisor", "adviser", "representative",
    "agent", "executive", "researcher", "evaluator", "trainer", "professional",
    "practitioner", "associate", "intern", "writer", "editor", "marketer",
    "recruiter", "auditor", "controller", "buyer", "estimator", "technologist",
}

_IDENTITY_STOPWORDS: Set[str] = {
    "and", "of", "the", "a", "an", "with", "in", "for", "to", "at", "&",
}
_LEAD_SPLIT_RE = re.compile(r"\s+and\s+|,\s*", re.IGNORECASE)


def _meaningful_tokens(text: str) -> Set[str]:
    toks = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {t for t in toks if t not in _IDENTITY_STOPWORDS and len(t) >= 2}


def _ends_in_role_noun(phrase: str) -> bool:
    words = re.findall(r"[a-z0-9]+", phrase.lower())
    return bool(words) and words[-1] in _ROLE_HEAD_NOUNS


def enforce_summary_identity(md: str, jd_analysis: Dict[str, Any] | None) -> str:
    """Trim the summary's LEAD identity to the role(s) matching the JD title."""
    title_toks = _meaningful_tokens(str((jd_analysis or {}).get("job_title") or ""))
    if not title_toks:
        return md

    lines = md.split("\n")
    bounds = _section_bounds(
        lines,
        lambda s: s.startswith("## ") and s[3:].strip().lower() in _HIGHLIGHT_HEADINGS,
    )
    if not bounds:
        return md
    start, end = bounds

    pidx = next(
        (
            i
            for i in range(start + 1, end)
            if lines[i].strip()
            and lines[i].strip()[:2] not in ("- ", "* ")
            and not lines[i].strip().startswith("•")
        ),
        None,
    )
    if pidx is None:
        return md

    line = lines[pidx]
    m = re.search(r"\bwith\b", line, re.IGNORECASE)
    if not m:
        return md  # no "<role> with ..." anchor — leave it
    head, tail = line[: m.start()].rstrip(), line[m.start():]
    if len(head) > 70:
        return md  # too long to be a bare identity

    parts = [p.strip() for p in _LEAD_SPLIT_RE.split(head) if p.strip()]
    if len(parts) < 2:
        return md  # not a compound identity
    if not all(_ends_in_role_noun(p) for p in parts):
        return md  # e.g. "Data and Business Analyst" — single role, don't split

    scored = [(len(_meaningful_tokens(p) & title_toks), p) for p in parts]
    best = max(s for s, _ in scored)
    kept = [p for s, p in scored if s >= 1] or [p for s, p in scored if s == best][:1]
    if len(kept) == len(parts):
        return md  # every conjunct is on-axis — nothing to trim

    lines[pidx] = f"{' and '.join(kept)} {tail}"
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Two-sentence Highlights clamp
# ---------------------------------------------------------------------------

_HIGHLIGHT_HEADINGS = ("career highlights", "professional summary", "summary", "profile")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def clamp_two_sentences(md: str) -> str:
    lines = md.split("\n")
    bounds = _section_bounds(
        lines, lambda s: s.startswith("## ") and s[3:].strip().lower() in _HIGHLIGHT_HEADINGS
    )
    if not bounds:
        return md
    start, end = bounds

    prose_idx = [
        i for i in range(start + 1, end)
        if lines[i].strip() and not re.match(r"^\s*[-*•]", lines[i])
    ]
    if not prose_idx:
        return md
    full = " ".join(lines[i].strip() for i in prose_idx).strip()
    sentences = [s.strip() for s in _SENT_SPLIT_RE.split(full) if s.strip()]
    if len(sentences) <= 2:
        return md
    clamped = " ".join(sentences[:2])
    # Write the clamped prose into the first prose line, blank the rest.
    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = clamped
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Summary breadth/single-employer consistency
# ---------------------------------------------------------------------------
# When S1 frames the candidate's experience as breadth — "across multiple
# residential aged care settings", "several facilities", etc. — naming ONE
# specific employer in S2 ("at Jesmond Miranda Nursing Home") is a hard
# contradiction. The prompt forbids it, but the AI doesn't always comply.
#
# DURABILITY NOTE (why this is the "final" form):
#   The earlier versions of this gate tried to GUESS what an employer name
#   looks like with a capitalised-token regex, anchored at the end of the
#   sentence. Every new grammatical shape the model emitted ("…at X, where…",
#   "…at X, providing…", "…for X…") slipped past, so the bug kept "coming
#   back". This version does NOT guess. It reads the candidate's REAL employer
#   names straight out of their own Experience `###` headings, then strips any
#   of those exact names from S2 — wherever they appear, whatever follows.
#   Matching a known string is bullet-proof; guessing a pattern is not.

_BREADTH_RE = re.compile(
    r"\b(?:multiple|several|various|many)\s+(?:[a-z]+\s+){0,3}"
    r"(?:settings|facilities|sites|placements|locations|homes|wards|"
    r"units|environments|services|providers|employers)\b",
    re.IGNORECASE,
)

# Section headings whose `###` entries name an employer.
_SUMMARY_EXPERIENCE_HEADINGS = {
    "experience", "professional experience", "clinical experience",
    "work experience", "employment", "employment history",
}

# Strip a trailing date parenthetical and any "| Location" / ", Location" tail.
_HEADING_DATE_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")
_HEADING_FIELD_SPLIT_RE = re.compile(r"\s+[|–—]\s+|\s+-\s+")


_AU_LOCATION_RE = re.compile(
    r",\s*(?:NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b|,\s*Australia\b",
    re.IGNORECASE,
)
_DATE_LINE_RE = re.compile(r"\b20\d{2}\b|\bPresent\b|\bCurrent\b", re.IGNORECASE)


def _looks_like_org_name(line: str) -> bool:
    """Return True if `line` looks like a plain-text employer name rather than
    a location, date range, role title, or bullet."""
    s = line.strip()
    if not s or len(s) < 6:
        return False
    if s.startswith(("## ", "### ", "-", "*", "•", "·")):
        return False
    if _AU_LOCATION_RE.search(s):     # "Leichhardt, NSW, Australia"
        return False
    if _DATE_LINE_RE.search(s):       # "Mar 2026 – Present"
        return False
    return True


def _employer_candidates(lines: List[str]) -> List[str]:
    """Collect real employer-name strings from the Experience section(s).

    Handles two formats:
      1. ``### Role | Org (Dates)`` heading format — both sides of the split.
      2. Plain-text format (W8 nursing CVs) — the first non-blank, non-bullet
         line of each block within the Experience section.

    Returns candidates longest-first so the fullest name is tried before
    any prefix (avoids "Uniting" matching before "Uniting – The Marion").
    """
    cands: Set[str] = set()
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if s.startswith("## ") and s[3:].strip().lower() in _SUMMARY_EXPERIENCE_HEADINGS:
            i += 1
            prev_blank = True  # treat section start as after a blank line
            while i < n and not lines[i].strip().startswith("## "):
                h = lines[i].strip()
                if h.startswith("### "):
                    # Format 1: ### heading
                    head = _HEADING_DATE_PAREN_RE.sub("", h[4:].strip())
                    parts = _HEADING_FIELD_SPLIT_RE.split(head)
                    for p in parts:
                        name = p.split(",")[0].strip()
                        if len(name) >= 6:
                            cands.add(name)
                    prev_blank = False
                elif not h:
                    prev_blank = True
                elif prev_blank and _looks_like_org_name(h):
                    # Format 2: plain-text org name at start of block
                    cands.add(h)
                    prev_blank = False
                else:
                    prev_blank = False
                i += 1
            continue
        i += 1
    return sorted(cands, key=len, reverse=True)


def _tidy_clause(s: str) -> str:
    """Repair a sentence after an 'at <employer>' span was excised: collapse
    whitespace, reattach punctuation, drop any now-dangling leading connector,
    re-capitalise, and guarantee terminal punctuation."""
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)          # " ," -> ","
    s = re.sub(r"^(?:and|or|but|,|;)\s+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+(?:and|or)\s*([.!?])", r"\1", s)  # "… and ." -> "…."
    s = re.sub(r",\s*,", ", ", s)
    s = s.strip()
    if s:
        s = s[0].upper() + s[1:]
    if s and s[-1] not in ".!?":
        s += "."
    return s


def _strip_named_employers(s2: str, candidates: List[str]) -> str:
    """Remove every 'at <known employer>' from S2. If the employer sat at the
    sentence tail (nothing but terminal punctuation after it) it is replaced
    with a scope phrase so S2 stays a complete, breadth-aligned thought;
    mid-sentence mentions are simply excised and the clause repaired."""
    out = s2
    for name in candidates:
        # (start-of-string | whitespace) + 'at' + name, on a word boundary.
        pat = re.compile(
            r"(?:^|\s)at\s+" + re.escape(name) + r"(?![\w'])",
            re.IGNORECASE,
        )
        while True:
            m = pat.search(out)
            if not m:
                break
            after = out[m.end():]
            is_tail = after.strip() == "" or after.lstrip()[:1] in (".", "!", "?")
            replacement = " across these settings" if is_tail else ""
            out = out[: m.start()] + replacement + out[m.end():]

        # Dangling fragment fix: LLM sometimes drops the first word of a
        # compound org name like "Uniting – The Marion", writing "care – The Marion"
        # instead of "care at Uniting – The Marion". The "at … name" pattern above
        # won't fire, but "– <partial_name>" is stranded. Strip it.
        if "–" in name or "—" in name or "-" in name:
            # Try each suffix after a dash separator.
            for sep in ("–", "—", "-"):
                if sep in name:
                    suffix = name.split(sep, 1)[1].strip()
                    if len(suffix) >= 4:
                        frag_pat = re.compile(
                            r"\s*[–—-]\s+" + re.escape(suffix) + r"(?![\w'])",
                            re.IGNORECASE,
                        )
                        out = frag_pat.sub("", out)

    return _tidy_clause(out) if out != s2 else s2


def enforce_summary_breadth_consistency(md: str) -> str:
    """If the summary's S1 uses breadth framing (multiple/several settings,
    facilities, sites, placements, etc.) AND S2 names a SINGLE specific
    employer drawn from the CV's own Experience section, strip that employer so
    S1 and S2 tell the same story.

    Examples (employer = "Jesmond Miranda Nursing Home"):
      "…provided care at Jesmond Miranda Nursing Home."
        → "…provided care across these settings."
      "…at Jesmond Miranda Nursing Home and provided care."
        → "…and provided care."
      "…at Jesmond Miranda Nursing Home, providing person-centred care."
        → "…, providing person-centred care."

    No-op when:
      - the Summary section is absent,
      - S1 doesn't use breadth framing,
      - S2 names no employer from the Experience section,
      - S2 names two employers via a semicolon (the rule allows that).
    """
    lines = md.split("\n")
    bounds = _section_bounds(
        lines,
        lambda s: s.startswith("## ") and s[3:].strip().lower() in _HIGHLIGHT_HEADINGS,
    )
    if not bounds:
        return md
    start, end = bounds

    prose_idx = [
        i for i in range(start + 1, end)
        if lines[i].strip() and not re.match(r"^\s*[-*•]", lines[i])
    ]
    if not prose_idx:
        return md
    full = " ".join(lines[i].strip() for i in prose_idx).strip()
    sentences = [s.strip() for s in _SENT_SPLIT_RE.split(full) if s.strip()]
    if len(sentences) < 2:
        return md

    s1, s2 = sentences[0], sentences[1]
    if not _BREADTH_RE.search(s1):
        return md  # S1 isn't breadth-framed — nothing to enforce.
    if ";" in s2:
        return md  # Two-clause S2 via semicolon (allowed when two dominant roles exist).

    candidates = _employer_candidates(lines)
    if not candidates:
        return md  # No employer names to match against.

    # Also allow S2 that explicitly mentions TWO known employers joined by "and"
    # (e.g. "at Uniting – The Marion and Jesmond Miranda Nursing Home"). That is
    # breadth-consistent — naming both dominant roles is fine.
    named_in_s2 = [c for c in candidates if re.search(re.escape(c), s2, re.IGNORECASE)]
    if len(named_in_s2) >= 2:
        return md

    new_s2 = _strip_named_employers(s2, candidates)
    if new_s2 == s2:
        return md  # S2 named no Experience employer — nothing to strip.

    rest = sentences[2:] if len(sentences) > 2 else []
    new_prose = " ".join([s1, new_s2] + rest)

    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Summary S1↔S2 de-duplication
# ---------------------------------------------------------------------------
# The professional summary must be EXACTLY two sentences that tell a progressive
# story — S2 should add competencies/outcomes NOT already in S1. The model
# sometimes writes S2 as a near-restatement of S1 (S1 "medication support …
# person-centred care" → S2 "electronic medication administration … personal
# care …"), which reads as padding and just re-lists the Skills section.
#
# This deterministic gate removes any S2 *clause* (comma-separated span) whose
# meaningful content words are ALL already covered by S1 — i.e. the clause adds
# no new concept. It is conservative by construction:
#   • generic modifier adjectives ("comprehensive", "ongoing", …) are ignored
#     when judging redundancy, so "comprehensive personal care" is recognised as
#     a restatement of S1's "person-centred care";
#   • a clause survives the moment it carries ONE genuinely new content word
#     ("electronic", "dementia", a named system), so distinct value is never
#     lost;
#   • the LAST surviving clause is never dropped — S2 always keeps real content;
#   • a content word "covers" another when they share a 4-char prefix, catching
#     morphological variants (residents/residential, support/supporting) without
#     a stemmer.

# Filler adjectives/adverbs that carry no distinct competency on their own — we
# ignore them when deciding whether an S2 clause merely restates S1.
_SUMMARY_FILLER_WORDS = {
    "comprehensive", "extensive", "thorough", "detailed", "holistic", "ongoing",
    "various", "varied", "strong", "excellent", "effective", "efficient", "broad",
    "general", "advanced", "quality", "daily", "regular", "consistent", "dedicated",
    "compassionate", "solid", "sound", "proven", "demonstrated", "professional",
    "exceptional", "outstanding", "robust", "reliable", "diverse", "wide",
    "extensively", "experienced", "skilled", "providing", "provided", "delivering",
    "delivered", "supporting", "support", "including", "across", "within", "while",
    "with", "and", "the", "for", "their", "them", "that", "this", "these", "those",
    "from", "into", "onto", "over", "under", "throughout", "where", "which", "who",
    "whom", "whose", "when", "what", "also", "both", "each", "every", "such", "very",
    "more", "most", "much", "many", "some", "any", "all", "well",
}

_SUMMARY_WORD_RE = re.compile(r"[a-z][a-z'\-]*")


def _summary_content_words(text: str) -> List[str]:
    """Lowercased content tokens (≥4 chars, not filler), hyphens split out so
    'person-centred' contributes both 'person' and 'centred'."""
    out: List[str] = []
    for tok in _SUMMARY_WORD_RE.findall(text.lower()):
        for part in tok.split("-"):
            part = part.strip("'")
            if len(part) >= 4 and part not in _SUMMARY_FILLER_WORDS:
                out.append(part)
    return out


def _word_covered_by(word: str, pool: List[str]) -> bool:
    """A content word is 'covered' if `pool` holds a word sharing its 4-char
    prefix (handles support/supporting, residents/residential, care/caring)."""
    p = word[:4]
    return any(w[:4] == p for w in pool)


def enforce_summary_dedup(md: str) -> str:
    """Drop fully-redundant S2 clauses that merely restate S1 (see header)."""
    lines = md.split("\n")
    bounds = _section_bounds(
        lines,
        lambda s: s.startswith("## ") and s[3:].strip().lower() in _HIGHLIGHT_HEADINGS,
    )
    if not bounds:
        return md
    start, end = bounds

    prose_idx = [
        i for i in range(start + 1, end)
        if lines[i].strip() and not re.match(r"^\s*[-*•]", lines[i])
    ]
    if not prose_idx:
        return md
    full = " ".join(lines[i].strip() for i in prose_idx).strip()
    sentences = [s.strip() for s in _SENT_SPLIT_RE.split(full) if s.strip()]
    if len(sentences) < 2:
        return md

    s1, s2 = sentences[0], sentences[1]
    # A two-clause S2 joined by a SEMICOLON is the intentional "two distinct
    # roles" shape — leave it untouched.
    if ";" in s2:
        return md

    # Split S2 into comma clauses, stripping a leading "and " on each.
    raw_clauses = [c.strip() for c in s2.rstrip(".!?").split(",")]
    clauses = [re.sub(r"^(?:and|or)\s+", "", c, flags=re.IGNORECASE).strip() for c in raw_clauses]
    clauses = [c for c in clauses if c]
    if len(clauses) < 2:
        return md  # nothing to thin out

    s1_words = _summary_content_words(s1)

    kept: List[str] = []
    dropped = 0
    for c in clauses:
        cwords = _summary_content_words(c)
        # Redundant = has content AND every content word is already covered by S1.
        redundant = bool(cwords) and all(_word_covered_by(w, s1_words) for w in cwords)
        if redundant and dropped < len(clauses) - 1:
            dropped += 1
            continue
        kept.append(c)

    if not dropped or not kept:
        return md

    # Reassemble: "A and B" for two, "A, B, and C" for three+.
    if len(kept) == 1:
        new_s2 = kept[0]
    elif len(kept) == 2:
        new_s2 = f"{kept[0]} and {kept[1]}"
    else:
        new_s2 = ", ".join(kept[:-1]) + f", and {kept[-1]}"
    new_s2 = _tidy_clause(new_s2)

    rest = sentences[2:] if len(sentences) > 2 else []
    new_prose = " ".join([s1, new_s2] + rest)

    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Summary title de-dup. The TITLE SLOT rule (a) in composition.py says:
# when the candidate's CV has synonymous role variants (Assistant in Nursing /
# Care Worker / Personal Care Assistant — same job, different employers; or
# Data Analyst / BI Analyst / Reporting Analyst), the summary opener should
# name ONLY ONE of them. The model sometimes chains both ("Assistant in
# Nursing and Care Worker with experience…"). This gate strips the second
# conjoined synonym so the opener reads as a single coherent identity.
#
# Conservative by design:
# - Only fires when BOTH titles belong to the SAME curated cluster (so we
#   never collapse genuinely-different roles like Cleaner + Receptionist).
# - Only operates on the opener of S1, anchored by a small set of follower
#   verbs ("with", "having", "delivering", "driving", "specialising").
# - Idempotent.
# ---------------------------------------------------------------------------

# Synonym clusters — each frozenset contains lowercased phrases that refer
# to the SAME job at different employers. Add to a cluster sparingly; never
# include words from two genuinely-different roles in one cluster.
_SYNONYM_TITLE_CLUSTERS: tuple = (
    # Nursing / aged-care / disability — entry-level
    frozenset({
        "assistant in nursing", "ain", "care worker", "personal care assistant",
        "pca", "personal care worker", "aged care worker", "support worker",
        "disability support worker", "individual support worker",
        "home care worker", "community care worker",
    }),
    # Nursing — licensed
    frozenset({
        "registered nurse", "rn", "division 1 nurse",
        "enrolled nurse", "en", "division 2 nurse",
    }),
    # Data / analytics
    frozenset({
        "data analyst", "bi analyst", "business intelligence analyst",
        "reporting analyst", "analytics analyst",
    }),
    # Software engineering
    frozenset({
        "software engineer", "software developer",
        "backend engineer", "backend developer",
        "full-stack developer", "full stack developer", "fullstack developer",
        "frontend engineer", "frontend developer",
    }),
)

_TITLE_OPENER_RE = re.compile(
    r"^(?P<t1>[A-Z][\w\-\s]*?)\s+and\s+(?P<t2>[A-Z][\w\-\s]*?)\s+"
    r"(?P<rest>with\b|having\b|delivering\b|driving\b|specialising\b|specializing\b)",
)


def enforce_summary_title_dedup(md: str) -> str:
    """Strip a conjoined synonymous title from the summary opener (S1).
    See section header for rationale and safety nets. Idempotent."""
    lines = md.split("\n")
    bounds = _section_bounds(
        lines,
        lambda s: s.startswith("## ") and s[3:].strip().lower() in _HIGHLIGHT_HEADINGS,
    )
    if not bounds:
        return md
    start, end = bounds

    prose_idx = [
        i for i in range(start + 1, end)
        if lines[i].strip() and not re.match(r"^\s*[-*•]", lines[i])
    ]
    if not prose_idx:
        return md
    full = " ".join(lines[i].strip() for i in prose_idx).strip()
    sentences = [s.strip() for s in _SENT_SPLIT_RE.split(full) if s.strip()]
    if not sentences:
        return md
    s1 = sentences[0]

    m = _TITLE_OPENER_RE.match(s1)
    if not m:
        return md
    t1_norm = re.sub(r"\s+", " ", m.group("t1").strip().lower())
    t2_norm = re.sub(r"\s+", " ", m.group("t2").strip().lower())
    same_cluster = any(t1_norm in c and t2_norm in c for c in _SYNONYM_TITLE_CLUSTERS)
    if not same_cluster:
        return md

    # Keep t1, drop "and t2", keep follower verb + rest. Slice to preserve
    # original casing of the kept title.
    rest_start = m.start("rest")
    new_s1 = m.group("t1") + " " + s1[rest_start:]
    new_s1 = re.sub(r"\s+", " ", new_s1).strip()
    if new_s1 == s1:
        return md

    rest_sentences = sentences[1:]
    new_prose = " ".join([new_s1] + rest_sentences)
    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Summary-vs-Skills de-duplication. The IT-shaped summary template wants S2
# to read "method + quantified result" — distinct from the keyword-dense
# Skills section. For nursing/care CVs, the care-types ARE both the skill
# keywords AND the methods (Personal Care, Dementia Care, Medication
# Assistance). When the model has nothing quantified to put in S2, it
# dutifully writes "delivering safe personal care and behavioural support"
# — every content word of which already appears in the Skills section.
# This gate drops any S2 clause where EVERY content word is already covered
# by the Skills pool. Always keeps at least one clause as a safety net.
# ---------------------------------------------------------------------------

# Re-uses _SKILLS_LINE_RE from writers.py for the category-line shape, but
# inlined here to avoid a cross-module import.
_SKILLS_CATEGORY_LINE_RE = re.compile(r"^(\s*(?:[-*•]\s+)?\*\*[^*]+:\*\*\s*)(.*)$")


def _skills_section_pool(md: str) -> List[str]:
    """Content words from every entry in every ## Skills category line.
    Uses the same content-word machinery as the S1-dedup gate, so coverage
    semantics match (4-char prefix, filler-word skip, hyphen split)."""
    lines = md.split("\n")
    bounds = _section_bounds(lines, lambda s: s.strip() == "## Skills")
    if not bounds:
        return []
    start, end = bounds
    pool: List[str] = []
    for i in range(start + 1, end):
        m = _SKILLS_CATEGORY_LINE_RE.match(lines[i])
        if not m:
            continue
        pool.extend(_summary_content_words(m.group(2)))
    return pool


def enforce_summary_skills_dedup(md: str) -> str:
    """Drop S2 clauses where EVERY content word is already in the ## Skills
    section (the clause merely re-lists skills as prose). Always keeps at
    least one S2 clause. Idempotent. See section header for rationale."""
    lines = md.split("\n")
    bounds = _section_bounds(
        lines,
        lambda s: s.startswith("## ") and s[3:].strip().lower() in _HIGHLIGHT_HEADINGS,
    )
    if not bounds:
        return md
    start, end = bounds

    prose_idx = [
        i for i in range(start + 1, end)
        if lines[i].strip() and not re.match(r"^\s*[-*•]", lines[i])
    ]
    if not prose_idx:
        return md
    full = " ".join(lines[i].strip() for i in prose_idx).strip()
    sentences = [s.strip() for s in _SENT_SPLIT_RE.split(full) if s.strip()]
    if len(sentences) < 2:
        return md

    s1, s2 = sentences[0], sentences[1]
    if ";" in s2:
        return md  # intentional two-distinct-roles shape — never thin it

    raw_clauses = [c.strip() for c in s2.rstrip(".!?").split(",")]
    clauses = [re.sub(r"^(?:and|or)\s+", "", c, flags=re.IGNORECASE).strip() for c in raw_clauses]
    clauses = [c for c in clauses if c]
    if len(clauses) < 2:
        return md

    skills_pool = _skills_section_pool(md)
    if not skills_pool:
        return md

    kept: List[str] = []
    dropped = 0
    for c in clauses:
        cwords = _summary_content_words(c)
        all_in_skills = bool(cwords) and all(_word_covered_by(w, skills_pool) for w in cwords)
        if all_in_skills and dropped < len(clauses) - 1:
            dropped += 1
            continue
        kept.append(c)

    if not dropped or not kept:
        return md

    if len(kept) == 1:
        new_s2 = kept[0]
    elif len(kept) == 2:
        new_s2 = f"{kept[0]} and {kept[1]}"
    else:
        new_s2 = ", ".join(kept[:-1]) + f", and {kept[-1]}"
    new_s2 = _tidy_clause(new_s2)

    rest = sentences[2:] if len(sentences) > 2 else []
    new_prose = " ".join([s1, new_s2] + rest)

    for i in prose_idx:
        lines[i] = ""
    lines[prose_idx[0]] = new_prose
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Degree relevance
# ---------------------------------------------------------------------------

_GRAD_RE = re.compile(
    r"\b(ph\.?d|doctorate|master(?:'s|s)?|m\.?sc|m\.?s\.?\b|m\.?a\.?\b|mba|m\.?phil)\b",
    re.IGNORECASE,
)
_BACHELOR_RE = re.compile(r"\b(bachelor|b\.?sc|b\.?a\.?\b|b\.?eng|undergrad)\b", re.IGNORECASE)
_REL_STOP = {
    "the", "and", "of", "in", "for", "with", "a", "an", "on", "to", "is", "as",
    "at", "by", "or", "from", "into", "via", "applied", "general", "studies",
    "study", "advanced", "introduction", "fundamentals", "master", "bachelor",
    "phd", "doctorate", "science", "degree", "university", "college", "institute",
    "gpa", "present",
}


def _jd_vocab(jd_analysis: Dict[str, Any]) -> Set[str]:
    bag: Set[str] = set()

    def add(text: str) -> None:
        for w in re.split(r"[^a-z0-9]+", (text or "").lower()):
            if len(w) >= 4 and w not in _REL_STOP:
                bag.add(w)

    if jd_analysis:
        add(str(jd_analysis.get("job_title") or ""))
        for block in ("required_skills", "preferred_skills"):
            cats = jd_analysis.get(block) or {}
            if isinstance(cats, dict):
                for cat in ("technical", "soft_skills", "domain_knowledge"):
                    for kw in cats.get(cat) or []:
                        add(str(kw))
    return bag


def enforce_degree_relevance(md: str, jd_analysis: Dict[str, Any]) -> str:
    """
    Drop graduate degrees (Master/PhD) whose line shares no token with the JD
    vocabulary. Always keep Bachelor's and never empty the section. Operates on
    the two-line '### Institution | Location' + '*Degree | Year*' block shape.
    """
    vocab = _jd_vocab(jd_analysis)
    if not vocab:
        return md

    lines = md.split("\n")
    bounds = _section_bounds(lines, lambda s: s.lower() == "## education")
    if not bounds:
        return md
    start, end = bounds

    entry_starts = [i for i in range(start + 1, end) if lines[i].lstrip().startswith("### ")]
    if len(entry_starts) <= 1:
        return md

    entries: List[tuple[int, int]] = []
    for idx, s in enumerate(entry_starts):
        e = entry_starts[idx + 1] if idx + 1 < len(entry_starts) else end
        entries.append((s, e))

    def _overlaps(blob: str) -> bool:
        toks = {w for w in re.split(r"[^a-z0-9]+", blob.lower()) if len(w) >= 4}
        return bool(toks & vocab)

    keep: List[bool] = []
    for (s, e) in entries:
        blob = " ".join(lines[s:e])
        is_grad = bool(_GRAD_RE.search(blob)) and not _BACHELOR_RE.search(blob)
        if is_grad and not _overlaps(blob):
            keep.append(False)
        else:
            keep.append(True)

    if all(keep):
        return md
    if not any(keep):
        # Every entry is an irrelevant grad degree (the model dropped the
        # Bachelor before the gate ran). Never empty Education — but don't keep
        # the whole pile of irrelevant degrees either. Keep only the FIRST
        # entry (CVs list education most-recent-first), so a data CV applying
        # to nursing shows one degree, not three off-topic physics degrees.
        keep[0] = True

    out: List[str] = lines[: start + 1]
    for idx, (s, e) in enumerate(entries):
        if keep[idx]:
            out.extend(lines[s:e])
    out.extend(lines[end:])
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Strip ungrounded tool parentheticals from bullets (SharePoint-class)
# ---------------------------------------------------------------------------

_BULLET_PREFIXES = ("- ", "* ", "• ")


def strip_ungrounded_bullet_parentheticals(md: str, original_cv_text: str) -> str:
    """
    Remove parenthetical clauses that name an ungrounded entity from EXPERIENCE
    / PROJECT bullets, e.g. "...dashboards (integrated with SharePoint)..." when
    SharePoint isn't in the CV. Scoped to bullet lines only, so legitimate
    Skills inferences like "Power BI (DAX, M language)" are untouched.
    """
    report = compute_grounding(md, original_cv_text)
    toks = sorted(
        {t.strip() for t in (report.get("ungrounded") or []) if len(t.strip()) >= 3},
        key=len, reverse=True,
    )
    if not toks:
        return md
    alt = "|".join(re.escape(t) for t in toks)
    paren_re = re.compile(r"\s*\([^)]*(?:" + alt + r")[^)]*\)", re.IGNORECASE)

    out: List[str] = []
    for line in md.split("\n"):
        if line.lstrip().startswith(_BULLET_PREFIXES):
            line = paren_re.sub("", line)
        out.append(line)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Strip ungrounded named-entity SKILL items (BigQuery-class)
#
# verify_claims only fact-checks Experience/Projects bullets, and the bullet
# parenthetical strip above only touches bullet lines — so a fabricated tool /
# product / proper noun placed in the ## Skills line (the prime ATS keyword-
# stuffing surface) survives every gate for non-"none" injection policies. This
# closes that hole deterministically, for EVERY role family: a fabricated proper
# noun is never policy-dependent. Generic lowercase skill words and items that
# share a CV word are kept; only items whose HEAD token is in the ungrounded
# named-entity set are dropped.
# ---------------------------------------------------------------------------

_SKILLS_LABEL_RE = re.compile(r"^\s*\*\*([^*]+?):\*\*\s*(.*)$")


def strip_ungrounded_skill_entities(
    md: str, original_cv_text: str, allow: "frozenset[str] | set[str]" = frozenset(),
) -> str:
    """
    Drop any ## Skills item whose head token is a named entity absent from the
    original CV, using the same detector as the bullet check (compute_grounding).
    The head is the text before any parenthesis, so 'Power BI (DAX)' is judged on
    'Power BI' (kept when grounded), not the parenthetical.

    `allow` is the normalised set of keywords the feasibility plan / equivalence
    table deliberately authorised (inject_directly) — these are honest by
    construction (e.g. CV says 'SQL' → 'PostgreSQL' / 'Cloud' is a defensible
    child→parent surfacing) even though they are not literal CV substrings, so
    they are never stripped. compute_grounding is stricter than the curated
    equivalence rule; this keeps the two from fighting.
    """
    if not original_cv_text:
        return md
    report = compute_grounding(md, original_cv_text)
    ungrounded = {_norm(t) for t in (report.get("ungrounded") or []) if t.strip()}
    if not ungrounded:
        return md
    allow_norm = {_norm(a) for a in allow if a}

    lines = md.split("\n")
    bounds = _section_bounds(lines, lambda s: s.lower() == "## skills")
    if not bounds:
        return md
    start, end = bounds

    for i in range(start + 1, end):
        m = _SKILLS_LABEL_RE.match(lines[i])
        if not m:
            continue
        label, rest = m.group(1).strip(), m.group(2).strip()
        kept: List[str] = []
        for item in _split_items(rest):
            head_norm = _norm(item.split("(")[0])
            if head_norm in ungrounded and head_norm not in allow_norm and _norm(item) not in allow_norm:
                continue  # fabricated named entity, not an authorised inference → drop
            kept.append(item)
        lines[i] = f"**{label}:** " + ", ".join(kept)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Domain-knowledge = direct-only (universal honesty rule)
#
# Confirmed systematic across two different JDs (CAE "financial analysis";
# MONEYME "transaction monitoring"): the feasibility classifier approves
# gray-zone DOMAIN-KNOWLEDGE terms as injectable, and the writer surfaces a
# domain competency the candidate doesn't have. You can infer a TOOL
# (SQL->PostgreSQL) and reframe a SOFT skill, but you cannot infer DOMAIN
# EXPERTISE — you either have fraud/AML/clinical experience or you don't.
#
# This demotes every domain_knowledge entry out of inject_as_extension /
# inject_with_inference into cannot_inject, for ALL verticals. inject_directly
# domain entries (literally anchored in the CV) are kept.
# ---------------------------------------------------------------------------


def restrict_domain_to_direct(feasibility: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(feasibility, dict):
        return feasibility
    plan = feasibility.get("feasibility_plan")
    if not isinstance(plan, dict):
        return feasibility

    new_plan: Dict[str, Any] = {
        k: (list(v) if isinstance(v, list) else v) for k, v in plan.items()
    }
    demoted: List[Dict[str, Any]] = []
    for bucket in ("inject_as_extension", "inject_with_inference"):
        kept: List[Any] = []
        for entry in (new_plan.get(bucket) or []):
            if isinstance(entry, dict) and str(entry.get("category", "")).strip() == "domain_knowledge":
                demoted.append({
                    "keyword": entry.get("keyword"),
                    "category": "domain_knowledge",
                    "bucket": entry.get("bucket"),
                    "reason": "domain expertise cannot be inferred — surfaced only when literally in the CV",
                })
            else:
                kept.append(entry)
        new_plan[bucket] = kept
    if demoted:
        new_plan["cannot_inject"] = list(new_plan.get("cannot_inject") or []) + demoted

    out = dict(feasibility)
    out["feasibility_plan"] = new_plan
    return out


# ---------------------------------------------------------------------------
# Convenience: run all W3 gates in order
# ---------------------------------------------------------------------------


def apply_w3_gates(
    md: str,
    *,
    jd_text: str,
    jd_analysis: Dict[str, Any],
    suppress: bool,
    original_cv_text: str = "",
    keep_skills: "frozenset[str] | set[str]" = frozenset(),
) -> str:
    if suppress:
        md = suppress_ai_identity(md, jd_text, jd_analysis)
    md = enforce_summary_identity(md, jd_analysis)
    md = clamp_two_sentences(md)
    md = enforce_degree_relevance(md, jd_analysis)
    if original_cv_text:
        md = strip_ungrounded_bullet_parentheticals(md, original_cv_text)
        md = strip_ungrounded_skill_entities(md, original_cv_text, keep_skills)
    return md
