"""
Layer-A fabrication grounding check (deterministic).

Principle: nothing in the tailored CV should name a tool, technology, or
proper noun that does not appear in the ORIGINAL CV. Named entities are the
high-risk fabrication surface (e.g. "Jira", "MS Office", "Planisware") — the
exact class of failure seen in diagnosis. Free-text rewording is lower risk
and not checked here (that is Layer B, a focused LLM fact-check, added later).

For now this runs as an EVAL METRIC only — it reports, it does not strip.
The same function becomes the production guard once the approach is validated.

Output:
    {
      "ungrounded": [str, ...],   # named entities in tailored not in original CV
      "ungrounded_count": int,
      "checked_count": int,       # distinct named entities examined
    }
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

# Section headings, months, generic verbs/adjectives — never "fabrications".
_STOPCAPS = {
    "data", "analyst", "engineer", "developer", "scientist", "manager",
    "lead", "senior", "principal", "staff", "director", "officer", "assistant",
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec", "present", "current",
    "delivered", "built", "improved", "enhanced", "optimised", "optimized",
    "automated", "managed", "designed", "shipped", "migrated", "mentored",
    "analysed", "analyzed", "developed", "created", "implemented", "led",
    "supported", "collaborated", "reduced", "increased", "achieved",
    # more clause-initial action verbs (often capitalised after a dash / pipe /
    # heading, e.g. "Award – Recognised for…", "Placement | Completed Sept…") —
    # never tool/product names, so they must never read as fabricated entities.
    "recognised", "recognized", "completed", "awarded", "received", "served",
    "provided", "executed", "maintained", "monitored", "transported",
    "evaluated", "deployed", "selected", "nominated", "promoted", "trained",
    "certified", "ensured", "serve", "deliver", "provide", "maintain",
    "monitor", "collaborate", "evaluate",
    # section labels
    "skills", "technical", "soft", "other", "career", "highlights",
    "professional", "experience", "education", "projects", "certifications",
    "summary", "profile", "contact", "languages", "interests", "references",
    "tools", "responsibilities", "achievements", "core", "clinical",
    "registration", "licences", "licenses", "availability", "work",
    # generic concept / soft-skill words — these are skill labels, not
    # fabricated proper nouns, so they should never count as "ungrounded".
    "thinking", "management", "communication", "collaboration", "problem",
    "solving", "improvement", "continuous", "analytical", "stakeholder",
    "attention", "detail", "documentation", "requirements", "mindset",
    "adaptability", "teamwork", "leadership", "intelligence", "business",
    "dashboard", "dashboards", "reporting", "analytics", "development",
    "extraction", "understanding", "gathering", "cross", "functional",
    "time", "design", "modelling", "modeling", "statistical", "analysis",
    "predictive", "forecasting", "optimization", "optimisation",
}

# Adjectival compound suffixes — strip before grounding ("python-based" grounds
# via "python") so they don't read as fabrications.
_COMPOUND_SUFFIX_RE = re.compile(
    r"-(based|driven|focused|led|level|oriented|ready|first|centric|wide)\b",
    re.IGNORECASE,
)

# Capitalised multi-word phrases ("CV Agent", "Power BI", "Charles Darwin").
_MULTI_RE = re.compile(r"\b([A-Z][\w&.+]*(?:\s+[A-Z][\w&.+]*){1,3})\b")
# All-caps acronyms 2+ chars, optional trailing digits ("AWS", "DAX", "GA4").
_ACRO_RE = re.compile(r"\b([A-Z]{2,}\d*)\b")
# Slash/hyphen tech tokens ("Flutter/Dart", "scikit-learn").
_SLASH_RE = re.compile(r"\b(\w+[/][\w/]+)\b")
# A single Title-case / product-ish token ("Jira", "Snowflake", "Planisware").
_SINGLE_RE = re.compile(r"^[A-Z][A-Za-z0-9][A-Za-z0-9.+#&/-]*$")
# Sentence terminators — a token right after one is a fresh sentence start.
_SENT_END = (".", "!", "?", ":", ";")
# Leading markdown / list / emphasis markers to strip from a line start.
_LINE_PREFIX_RE = re.compile(r"^[\s>#*\-•\d.()\[\]]+")


def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _scannable(markdown: str) -> str:
    """
    Strip lines that aren't fabrication surfaces: the H1 name and the contact
    line (emails, URLs, social handles). These produce false positives like
    "com/in/tiwarimahesh" that aren't real fabricated entities.
    """
    out: List[str] = []
    for raw in (markdown or "").splitlines():
        s = raw.strip()
        if s.startswith("# ") and not s.startswith("## "):
            continue  # H1 name line
        low = s.lower()
        if "@" in s or "http" in low or "linkedin" in low or "github" in low:
            continue  # contact line
        out.append(raw)
    return "\n".join(out)


def _single_word_candidates(markdown: str) -> list[str]:
    """
    Find single Title-case tokens used MID-sentence — the surface where
    single-word tool/product fabrications hide (e.g. "(e.g., Jira)",
    "using SharePoint"). Sentence-initial words are skipped because those are
    usually action verbs ("Built", "Improved"), not proper nouns.
    """
    out: list[str] = []
    for raw in (markdown or "").splitlines():
        line = _LINE_PREFIX_RE.sub("", raw)
        if not line.strip():
            continue
        words = line.split()
        prev_ended = True  # first token of the line == sentence start
        for w in words:
            core = w.strip("*_`\"'()[],.;:!?")
            is_start = prev_ended
            prev_ended = w.rstrip("*_`\"')]").endswith(_SENT_END)
            if is_start:
                continue
            if len(core) < 3 or core.lower() in _STOPCAPS:
                continue
            if _SINGLE_RE.match(core):
                out.append(core)
    return out


def compute_grounding(tailored_markdown: str, original_cv_text: str) -> Dict[str, Any]:
    """Return the set of named entities present in tailored but absent from the CV."""
    original_norm = _normalise(original_cv_text)
    original_blob = f" {original_norm} "

    scan_text = _scannable(tailored_markdown or "")
    candidates: List[str] = []

    for m in _MULTI_RE.finditer(scan_text):
        token = m.group(1).strip()
        words = [w.lower() for w in re.split(r"\s+", token)]
        if all(w in _STOPCAPS for w in words):
            continue
        candidates.append(token)

    for m in _ACRO_RE.finditer(scan_text):
        token = m.group(1)
        if token.lower() in _STOPCAPS:
            continue
        candidates.append(token)

    for m in _SLASH_RE.finditer(scan_text):
        candidates.append(m.group(1))

    candidates.extend(_single_word_candidates(scan_text))

    # Dedupe, preserve order, case-insensitive.
    seen: set[str] = set()
    unique: List[str] = []
    for c in candidates:
        key = c.lower()
        if key not in seen:
            seen.add(key)
            unique.append(c)

    ungrounded: List[str] = []
    for token in unique:
        # Strip adjectival compound suffixes so "Python-based" grounds via "python".
        norm = _normalise(_COMPOUND_SUFFIX_RE.sub("", token))
        if not norm:
            continue
        # A single short content word that is itself a generic concept is noise.
        if " " not in norm and norm in _STOPCAPS:
            continue
        # Grounded if the normalised entity appears as a substring of the CV,
        # OR every alphanumeric word of it appears somewhere in the CV (handles
        # reordering / punctuation differences).
        if f" {norm} " in original_blob or norm in original_norm:
            continue
        parts = [p for p in norm.split(" ") if len(p) >= 2]
        if parts and all(f" {p} " in original_blob for p in parts):
            continue
        ungrounded.append(token)

    return {
        "ungrounded": ungrounded,
        "ungrounded_count": len(ungrounded),
        "checked_count": len(unique),
    }
