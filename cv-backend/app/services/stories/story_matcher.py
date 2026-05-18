"""
Deterministic story-to-JD matching — Phase 10.2.b.

No AI call. Pure keyword overlap between JD text and story fields,
with a small bonus for stories that contain concrete numbers.

Public API
----------
score_stories(jd_text, stories) → list[dict]

Each returned dict has:
  story_id : str   — the DB UUID of the story (from the `id` field)
  score    : float — normalised relevance score in [0.0, 1.0]

Sorted descending by score. Stories without an `id` field are skipped
and logged — they should not reach this function from the match endpoint
(DB rows always have ids), but we degrade gracefully rather than raise.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# ── Stop-word list ────────────────────────────────────────────────────────────
# English function words only. Industry terms (e.g. "led", "built") are
# intentionally excluded so they contribute to matching signals.
_STOP_WORDS: frozenset[str] = frozenset({
    # articles
    "the", "a", "an",
    # prepositions
    "of", "in", "on", "at", "to", "for", "with", "by", "from", "into",
    "about", "through", "between", "against", "during", "before", "after",
    "above", "below", "under", "over", "within", "without", "around",
    "among", "along", "upon", "onto", "off", "out",
    # conjunctions
    "and", "or", "but", "nor", "so", "yet", "if", "as", "that", "than",
    "when", "while", "where", "which", "who", "whom", "whose", "although",
    "though", "because", "since", "unless", "until", "whether", "both",
    # pronouns
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his",
    "she", "her", "it", "its", "they", "them", "their", "this", "these",
    "those", "what",
    # auxiliaries
    "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did",
    "will", "would", "shall", "should", "may", "might", "must", "can",
    "could",
    # quantifiers / determiners
    "all", "any", "each", "every", "either", "neither", "many", "much",
    "few", "more", "most", "some", "other", "such", "own", "same",
    "no", "not",
    # adverbs / particles
    "just", "very", "also", "too", "only", "even", "still", "already",
    "yet", "well", "then", "now", "here", "there", "how", "why", "up",
    "down", "back",
})

_NUMBERS_BONUS = 0.15  # added to raw overlap when a story has concrete numbers


def _tokenise(text: str) -> frozenset[str]:
    """Lowercase alpha tokens, ≥3 chars, stop-words removed."""
    tokens = re.findall(r"[a-z]{3,}", text.lower())
    return frozenset(t for t in tokens if t not in _STOP_WORDS)


def _story_text(story: dict) -> str:
    """Concatenate the fields used for matching."""
    tags_str = " ".join(story.get("tags") or [])
    return " ".join([
        story.get("domain") or "",
        story.get("one_line") or "",
        tags_str,
        story.get("detailed") or "",
    ])


def score_stories(jd_text: str, stories: list[dict]) -> list[dict]:
    """
    Rank stories by keyword relevance to jd_text.

    Parameters
    ----------
    jd_text : str
        Full job description text. Must be non-empty.
    stories : list[dict]
        Story dicts from the DB (must contain an 'id' key with the UUID).
        Each dict matches the Story Pydantic schema shape plus an 'id' field.

    Returns
    -------
    list[dict]
        [{"story_id": str, "score": float}, ...] sorted by score descending.
        Stories missing an 'id' are skipped with a warning log.
    """
    if not jd_text or not jd_text.strip():
        logger.warning("score_stories: empty jd_text — all stories get score 0.0")
        return [
            {"story_id": s["id"], "score": 0.0}
            for s in stories
            if s.get("id")
        ]

    jd_tokens = _tokenise(jd_text)
    jd_size = max(len(jd_tokens), 1)

    scored: list[dict] = []
    for story in stories:
        story_id = story.get("id")
        if not story_id:
            logger.warning("score_stories: story missing 'id' field — skipped")
            continue

        story_tokens = _tokenise(_story_text(story))
        overlap = len(jd_tokens & story_tokens) / jd_size

        has_numbers = bool(story.get("numbers"))
        raw = overlap + (_NUMBERS_BONUS if has_numbers else 0.0)
        final_score = min(raw, 1.0)

        scored.append({"story_id": story_id, "score": round(final_score, 4)})

    scored.sort(key=lambda x: x["score"], reverse=True)
    logger.info(
        "score_stories: ranked %d stories; top_score=%.4f",
        len(scored),
        scored[0]["score"] if scored else 0.0,
    )
    return scored
