"""
Deterministic company fact selection — Phase 10.3.

No AI call. Pure keyword overlap between (JD text + CV text) and each
fact field in CompanyFacts, following the story_matcher.py pattern exactly.

Public API
----------
select_facts(jd_text, cv_text, facts) → list[dict]

Each returned dict:
  fact_text    : str   — the fact string
  score        : float — normalised relevance score in [0.0, 1.0]
  source_field : str   — e.g. 'distinguishing_facts[0]', 'mission_statement'

Sorted descending by score.
"""
from __future__ import annotations

import logging
import re

from app.schemas.company import CompanyFacts

logger = logging.getLogger(__name__)

# English function words — same set as story_matcher.py
_STOP_WORDS: frozenset[str] = frozenset({
    "the", "a", "an",
    "of", "in", "on", "at", "to", "for", "with", "by", "from", "into",
    "about", "through", "between", "against", "during", "before", "after",
    "above", "below", "under", "over", "within", "without", "around",
    "among", "along", "upon", "onto", "off", "out",
    "and", "or", "but", "nor", "so", "yet", "if", "as", "that", "than",
    "when", "while", "where", "which", "who", "whom", "whose", "although",
    "though", "because", "since", "unless", "until", "whether", "both",
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his",
    "she", "her", "it", "its", "they", "them", "their", "this", "these",
    "those", "what",
    "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did",
    "will", "would", "shall", "should", "may", "might", "must", "can", "could",
    "all", "any", "each", "every", "either", "neither", "many", "much",
    "few", "more", "most", "some", "other", "such", "own", "same",
    "no", "not",
    "just", "very", "also", "too", "only", "even", "still", "already",
    "yet", "well", "then", "now", "here", "there", "how", "why", "up",
    "down", "back",
})


def _tokenise(text: str) -> frozenset[str]:
    """Lowercase alpha tokens ≥3 chars, stop-words removed."""
    tokens = re.findall(r"[a-z]{3,}", text.lower())
    return frozenset(t for t in tokens if t not in _STOP_WORDS)


def _score_fact(query_tokens: frozenset[str], fact_text: str) -> float:
    """Score a single fact string against the query token set."""
    if not fact_text or not fact_text.strip():
        return 0.0
    fact_tokens = _tokenise(fact_text)
    if not query_tokens:
        return 0.0
    overlap = len(query_tokens & fact_tokens) / max(len(query_tokens), 1)
    return round(min(overlap, 1.0), 4)


def _expand_facts(facts: CompanyFacts) -> list[tuple[str, str]]:
    """
    Enumerate all scoreable text fields from CompanyFacts.
    Returns list of (fact_text, source_field) pairs.
    """
    candidates: list[tuple[str, str]] = []

    if facts.mission_statement:
        candidates.append((facts.mission_statement, "mission_statement"))

    if facts.description_short:
        candidates.append((facts.description_short, "description_short"))

    for i, fact in enumerate(facts.distinguishing_facts):
        if fact:
            candidates.append((fact, f"distinguishing_facts[{i}]"))

    for i, evt in enumerate(facts.recent_events):
        combined = f"{evt.event} {evt.relevance_to_applicants}"
        candidates.append((combined, f"recent_events[{i}]"))

    for i, prod in enumerate(facts.products_or_services):
        if prod:
            candidates.append((prod, f"products_or_services[{i}]"))

    return candidates


def select_facts(
    jd_text: str,
    cv_text: str,
    facts: CompanyFacts,
) -> list[dict]:
    """
    Rank company facts by keyword relevance to jd_text + cv_text.

    Parameters
    ----------
    jd_text : str
        Full job description text.
    cv_text : str
        User's master CV text. Combined with JD for richer query signal.
    facts : CompanyFacts
        Validated CompanyFacts from the company_research row.

    Returns
    -------
    list[dict]
        [{"fact_text": str, "score": float, "source_field": str}, ...]
        sorted by score descending.
    """
    query_text = f"{jd_text} {cv_text}"
    query_tokens = _tokenise(query_text)

    if not query_tokens:
        logger.warning("select_facts: empty query tokens — returning unsorted facts")

    candidates = _expand_facts(facts)
    if not candidates:
        logger.warning("select_facts: no fact candidates extracted from CompanyFacts")
        return []

    scored = [
        {
            "fact_text": fact_text,
            "score": _score_fact(query_tokens, fact_text),
            "source_field": source_field,
        }
        for fact_text, source_field in candidates
    ]
    scored.sort(key=lambda x: x["score"], reverse=True)

    logger.info(
        "select_facts: ranked %d facts; top_score=%.4f source=%s",
        len(scored),
        scored[0]["score"] if scored else 0.0,
        scored[0]["source_field"] if scored else "—",
    )
    return scored
