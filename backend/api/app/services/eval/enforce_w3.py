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
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Set, Optional

logger = logging.getLogger(__name__)

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
# role really is AI-forward — so the candidate's AI identity should lead.
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
    """Suppress the candidate's AI identity unless the JD is genuinely AI-forward."""
    title_is_ai = jd_title_is_ai(jd_analysis)
    if not title_is_ai:
        md = _strip_title_ai_suffix(md)
    if not title_is_ai and not jd_has_ai_signal(jd_text):
        md = _strip_ai_skills(md)
        md = _drop_ai_projects(md)
    return md


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
# Summary S1↔S2 de-duplication
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Summary-vs-Skills de-duplication.
# ---------------------------------------------------------------------------

_SKILLS_CATEGORY_LINE_RE = re.compile(r"^(\s*(?:[-*•]\s+)?\*\*[^*]+:\*\*\s*)(.*)$")


def _skills_section_pool(md: str) -> List[str]:
    """Content words from every entry in every ## Skills category line."""
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
    """Drop S2 clauses where EVERY content word is already in the ## Skills section."""
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
        return md

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
# Strip ungrounded tool parentheticals from bullets (SharePoint-class)
# ---------------------------------------------------------------------------

_BULLET_PREFIXES = ("- ", "* ", "• ")


def strip_ungrounded_bullet_parentheticals(md: str, original_cv_text: str) -> str:
    """Remove parenthetical clauses that name an ungrounded entity."""
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
# ---------------------------------------------------------------------------

_SKILLS_LABEL_RE = re.compile(r"^\s*\*\*([^*]+?):\*\*\s*(.*)$")


def strip_ungrounded_skill_entities(
    md: str, original_cv_text: str, allow: "frozenset[str] | set[str]" = frozenset(),
) -> str:
    """Drop any ## Skills item whose head token is a named entity absent from the original CV."""
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
                continue
            kept.append(item)
        lines[i] = f"**{label}:** " + ", ".join(kept)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Domain-knowledge = direct-only (universal honesty rule)
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
# strip_off_vertical_preamble gate
# ---------------------------------------------------------------------------


def strip_off_vertical_preamble(md: str, jd_vertical: str) -> str:
    """Trim off-vertical background or student/visa preambles and clean off-vertical roles in S2."""
    if not jd_vertical:
        return md

    vert = jd_vertical.lower()
    is_care = any(k in vert for k in ["nurse", "nursing", "aged", "care", "support", "disability"])
    if not is_care:
        return md

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
    if not sentences:
        return md

    s1 = sentences[0]
    off_vert_pattern = re.compile(
        r"\b(?:accounting|finance|financial|business|commerce|marketing|mba|mpa|bba|bcom)\b",
        re.IGNORECASE
    )

    # 1. Check for conjoined background/student phrase in S1 with off-vertical terms.
    conjoined_match = re.search(
        r"\s+(?:and|or|,)\s+(?:(?:international|domestic)\s+)?(?:student|graduate|visa\s+holder)\b.*?\b(with|holding|who\s+(?:also\s+)?holds?)\s+",
        s1,
        re.IGNORECASE
    )
    if conjoined_match and off_vert_pattern.search(conjoined_match.group(0)):
        start_idx = conjoined_match.start()
        end_idx = conjoined_match.end()
        connector = conjoined_match.group(1)
        s1 = s1[:start_idx] + f" {connector} " + s1[end_idx:]
        s1 = re.sub(r"\s{2,}", " ", s1).strip()
        sentences[0] = s1

    # 2. Check for starting background in off-vertical areas.
    background_match = re.search(
        r"\bwith\s+(?:a\s+)?(?:strong\s+)?background\s+in\s+.*?\b(?:accounting|finance|financial|business|commerce|marketing|administration)\b.*?\b(and|with)\s+",
        s1,
        re.IGNORECASE
    )
    if background_match:
        start_idx = background_match.start()
        end_idx = background_match.end()
        s1 = s1[:start_idx] + " with " + s1[end_idx:]
        s1 = re.sub(r"\s{2,}", " ", s1).strip()
        sentences[0] = s1

    # 3. Check if S1 starts with student/graduate indicators, contains off-vertical term, and has a separator like "with", "holding", etc.
    student_lead_match = re.match(
        r"^(?:(?:international|domestic)\s+)?(?:student|graduate|visa\s+holder)\b.*?\b(with|holding|who\s+(?:also\s+)?holds?)\s+",
        s1,
        re.IGNORECASE
    )
    if student_lead_match and off_vert_pattern.search(s1[:student_lead_match.end()]):
        remainder = s1[student_lead_match.end():].strip()
        if remainder:
            remainder = remainder[0].upper() + remainder[1:]
            if not remainder.endswith("."):
                remainder += "."
            sentences[0] = remainder
            s1 = remainder

    # 4. Check for "student pursuing X. S2" -> where X has off-vertical terms and there is no "with"
    elif re.match(r"^(?:(?:international|domestic)\s+)?(?:student|graduate)\s+.*?\b(?:master|bachelor|mba|mpa|bba|bcom)\b", s1, re.IGNORECASE):
        if off_vert_pattern.search(s1) and len(sentences) > 1:
            sentences = sentences[1:]
            s1 = sentences[0] if sentences else ""

    # 5. Scrub S2 if it mentions conjoined off-vertical roles.
    if len(sentences) >= 2:
        s2 = sentences[1]
        cleaned_s2 = s2
        cleaned_s2 = re.sub(
            r"\bboth\s+(\w+)\s+and\s+(?:accounting|finance|financial|business|commerce|marketing|administration)\s+(roles?|backgrounds?|experience)",
            r"\1 \2", cleaned_s2, flags=re.IGNORECASE,
        )
        cleaned_s2 = re.sub(
            r"\band\s+(?:accounting|finance|financial|business|commerce|marketing|administration)\s+(roles?|backgrounds?|experience)",
            r"", cleaned_s2, flags=re.IGNORECASE,
        )
        cleaned_s2 = re.sub(
            r"\b(?:accounting|finance|financial|business|commerce|marketing|administration)\s+and\s+",
            r"", cleaned_s2, flags=re.IGNORECASE,
        )
        cleaned_s2 = re.sub(r"\s{2,}", " ", cleaned_s2).strip()
        if cleaned_s2 != s2:
            sentences[1] = cleaned_s2

    if sentences:
        new_prose = " ".join(sentences)
        for i in prose_idx:
            lines[i] = ""
        lines[prose_idx[0]] = new_prose
        return "\n".join(lines)

    return md


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
    jd_vertical: Optional[str] = None,
) -> str:
    if suppress:
        md = suppress_ai_identity(md, jd_text, jd_analysis)
    md = clamp_two_sentences(md)
    _vert = jd_vertical or jd_analysis.get("vertical")
    if _vert:
        md = strip_off_vertical_preamble(md, _vert)
    if original_cv_text:
        md = strip_ungrounded_bullet_parentheticals(md, original_cv_text)
        md = strip_ungrounded_skill_entities(md, original_cv_text, keep_skills)
    return md
