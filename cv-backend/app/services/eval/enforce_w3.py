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


def suppress_ai_identity(md: str, jd_text: str) -> str:
    """Apply suppression only when the JD shows no AI signal."""
    if jd_has_ai_signal(jd_text):
        return md  # AI-forward role — keep the AI identity
    md = _strip_title_ai_suffix(md)
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
        return md  # safety: never empty Education

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
) -> str:
    if suppress:
        md = suppress_ai_identity(md, jd_text)
    md = clamp_two_sentences(md)
    md = enforce_degree_relevance(md, jd_analysis)
    if original_cv_text:
        md = strip_ungrounded_bullet_parentheticals(md, original_cv_text)
    return md
