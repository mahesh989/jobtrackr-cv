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
from typing import Optional

from app.schemas.company import CompanyFacts
from app.services.company.jd_geo import detect_country, fact_text_country_mismatch
from app.services.text_tokenise import tokenise as _tokenise

logger = logging.getLogger(__name__)


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
        # C67: evt.stale is injected by researcher.py (event date >12 months
        # old, or no parseable date at all — see schemas/company.py's design
        # notes) specifically so a stale event doesn't get featured as a
        # "recent" company fact in a cover letter. Before this fix, nothing
        # anywhere in the codebase actually read the flag once set — it was
        # write-only, so a stale event ranked and could be selected exactly
        # like a genuinely recent one.
        if evt.stale:
            continue
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
    jd_location: Optional[str] = None,
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
    jd_location : Optional[str]
        JD's job location. When supplied AND a country can be inferred, any
        candidate fact whose text references a DIFFERENT country is dropped
        before scoring (defends against same-name conflations like UK
        Sanctuary Group facts on an AU Sanctuary Care JD). None falls back
        to the geographically-naive ranking.

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

    # Geographic filter — drop candidates that mention a country other than
    # the JD's. Skipped when no JD country can be inferred (conservative —
    # never makes things worse than the legacy ranking).
    jd_country = detect_country(jd_location) if jd_location else None
    if jd_country:
        before = len(candidates)
        candidates = [
            (text, src) for text, src in candidates
            if not fact_text_country_mismatch(text, jd_country)
        ]
        dropped = before - len(candidates)
        if dropped:
            logger.info(
                "select_facts: dropped %d/%d wrong-country fact(s) (jd_country=%s)",
                dropped,
                before,
                jd_country,
            )

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
