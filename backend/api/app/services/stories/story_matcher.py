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

from app.services.text_tokenise import tokenise as _tokenise

logger = logging.getLogger(__name__)

# C67: this used to be a flat 0.15 added to `overlap` (matched_unique_tokens /
# jd_unique_token_count). `overlap` shrinks as the JD gets longer (more unique
# tokens in the denominator), but the old bonus didn't — so on a realistic
# JD (100-150+ unique tokens after stopword removal), a typical strong-match
# overlap (0.05-0.08) was smaller than the flat bonus alone. A story with
# ANY number, however irrelevant, could outrank a highly relevant
# number-free story. Scaled to the same denominator as overlap so it stays
# a small, proportionally-consistent tie-breaker regardless of JD length —
# roughly "worth" this many extra matched tokens, not a fixed score jump.
_NUMBERS_BONUS_TOKEN_EQUIVALENT = 1.5


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
        numbers_bonus = (_NUMBERS_BONUS_TOKEN_EQUIVALENT / jd_size) if has_numbers else 0.0
        raw = overlap + numbers_bonus
        final_score = min(raw, 1.0)

        scored.append({"story_id": story_id, "score": round(final_score, 4)})

    scored.sort(key=lambda x: x["score"], reverse=True)
    logger.info(
        "score_stories: ranked %d stories; top_score=%.4f",
        len(scored),
        scored[0]["score"] if scored else 0.0,
    )
    return scored
