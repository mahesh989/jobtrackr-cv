"""C67: score_stories()'s numeric bonus used to be a flat 0.15 added on top
of a normalised keyword-overlap fraction (matched_unique_tokens /
jd_unique_token_count). Overlap shrinks as the JD gets longer, but the flat
bonus didn't — so on a realistic-length JD, a story with ANY number,
however irrelevant, could outrank a highly relevant number-free story.
Fixed by scaling the bonus to the same denominator as overlap (jd_size), so
it stays a small, proportionally-consistent tie-breaker instead of a
dominant term.
"""
from __future__ import annotations

from app.services.stories.story_matcher import score_stories


import string

_LETTER_SUFFIXES = [a + b + c for a in string.ascii_lowercase for b in string.ascii_lowercase for c in string.ascii_lowercase]


def _long_jd(unique_word_count: int, matched_words: list[str]) -> str:
    """A synthetic JD with exactly `unique_word_count` unique >=3-char
    ALPHABETIC words, `matched_words` guaranteed present among them.
    _tokenise's regex ([a-z]{3,}) only matches letters, so a numeric
    suffix (e.g. "jdword0") collapses every filler word to the same
    token ("jdword") once the digit is stripped — filler must vary by
    LETTERS, not digits, to actually produce distinct unique tokens."""
    filler = [f"jdword{suffix}" for suffix in _LETTER_SUFFIXES[: unique_word_count - len(matched_words)]]
    words = matched_words + filler
    return " ".join(words)


def test_highly_relevant_story_outranks_irrelevant_numeric_story_on_a_realistic_jd():
    """The exact bug: a long JD (150 unique tokens), a story sharing 8 of
    them (strong overlap, no numbers) vs. a story sharing only 1 (weak
    overlap) that happens to carry a number. The relevant story must win."""
    matched = [f"nursing{suffix}" for suffix in _LETTER_SUFFIXES[:8]]
    jd_text = _long_jd(150, matched)

    relevant_no_numbers = {
        "id": "story-relevant",
        "domain": " ".join(matched),
        "one_line": "",
        "tags": [],
        "detailed": "",
        "numbers": None,
    }
    irrelevant_with_numbers = {
        "id": "story-irrelevant-numeric",
        "domain": matched[0],  # only 1 of the 8 matched words
        "one_line": "",
        "tags": [],
        "detailed": "",
        "numbers": ["3"],
    }

    scored = score_stories(jd_text, [irrelevant_with_numbers, relevant_no_numbers])
    ranking = [s["story_id"] for s in scored]
    assert ranking[0] == "story-relevant", (
        f"expected the 8-token-overlap story to rank first, got {scored}"
    )


def test_numbers_bonus_still_breaks_a_genuine_tie():
    """Control: when overlap is otherwise equal, the numeric story should
    still win — the bonus must not be reduced to zero, just to a fair
    tie-breaker size."""
    matched = [f"skill{suffix}" for suffix in _LETTER_SUFFIXES[:5]]
    jd_text = _long_jd(150, matched)

    with_numbers = {
        "id": "story-with-numbers", "domain": " ".join(matched),
        "one_line": "", "tags": [], "detailed": "", "numbers": ["42%"],
    }
    without_numbers = {
        "id": "story-without-numbers", "domain": " ".join(matched),
        "one_line": "", "tags": [], "detailed": "", "numbers": None,
    }

    scored = score_stories(jd_text, [without_numbers, with_numbers])
    by_id = {s["story_id"]: s["score"] for s in scored}
    assert by_id["story-with-numbers"] > by_id["story-without-numbers"]


def test_numbers_bonus_is_a_small_fraction_of_a_typical_overlap_score():
    """Guard against regressing back toward domination: the bonus for a
    150-unique-token JD should be well under a single well-matched token's
    worth of overlap (1/150 ≈ 0.0067), not a large fixed jump."""
    jd_text = _long_jd(150, ["uniquematch"])
    story = {
        "id": "s1", "domain": "uniquematch", "one_line": "", "tags": [],
        "detailed": "", "numbers": ["1"],
    }
    scored = score_stories(jd_text, [story])
    # 1 matched token (1/150) + bonus (1.5/150) = 2.5/150 ≈ 0.0167
    assert scored[0]["score"] < 0.05
