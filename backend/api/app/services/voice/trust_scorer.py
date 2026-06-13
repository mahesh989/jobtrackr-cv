"""
Deterministic trust scorer for voice writing samples.

Pure function — no I/O, no database calls, no model calls.
Input: raw text string. Output: TrustScore named tuple.

Trust score formula (MVP — in-app typing, Option 2 only):
    overall = 0.5 * ai_pattern_score
            + 0.3 * sentence_variance_score
            + 0.2 * length_appropriateness_score

Thresholds for callers:
    overall < 0.50 → show amber warning ("might be AI-assisted")
    overall < 0.25 → show red warning + suggest retry

Fixtures and expected values: trust_scorer_fixtures.py
"""
from __future__ import annotations

import math
import re
from typing import NamedTuple


class TrustScore(NamedTuple):
    overall_score: float
    ai_pattern_score: float
    sentence_variance_score: float
    length_appropriateness_score: float
    matched_ai_phrases: list[str]


# Phrases statistically associated with AI-generated writing.
# Case-insensitive substring match. Each unique match subtracts 0.2 from
# ai_pattern_score (floor 0.0). Five or more unique matches → score of 0.0.
_AI_TELLS: tuple[str, ...] = (
    "i am writing to",
    "i am excited to",
    "i am pleased to",
    "i am passionate about",
    "i am confident that",
    "i would like to express",
    "i look forward to",
    "furthermore",
    "moreover",
    "additionally",
    "in conclusion",
    "it is worth noting",
    "needless to say",
    "it goes without saying",
    "that being said",
    "with that said",
    "to this end",
    "in today's",
    "fast-paced",
    "results-driven",
    "track record",
    "leverage",
    "synergy",
)

# Sentence boundary pattern: split on . ! ? followed by whitespace or end.
# Avoids splitting on decimal numbers or common abbreviations.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def score(text: str) -> TrustScore:
    """
    Pure function: text → TrustScore.

    No logging inside this function — callers must not log the raw text
    argument (privacy boundary on voice_sample_raw).
    """
    lower = text.lower()
    words = text.split()
    word_count = len(words)

    ai_score = _ai_pattern_score(lower)
    var_score = _sentence_variance_score(text)
    len_score = _length_appropriateness_score(word_count)

    overall = round(
        0.5 * ai_score + 0.3 * var_score + 0.2 * len_score,
        4,
    )

    matched = sorted({p for p in _AI_TELLS if p in lower})

    return TrustScore(
        overall_score=overall,
        ai_pattern_score=round(ai_score, 4),
        sentence_variance_score=round(var_score, 4),
        length_appropriateness_score=round(len_score, 4),
        matched_ai_phrases=matched,
    )


# ---------------------------------------------------------------------------
# Component scorers
# ---------------------------------------------------------------------------


def _ai_pattern_score(lower_text: str) -> float:
    """0.2 penalty per unique AI-tell phrase found. Floor 0.0."""
    unique_hits = sum(1 for p in _AI_TELLS if p in lower_text)
    return max(0.0, 1.0 - 0.2 * unique_hits)


def _sentence_variance_score(text: str) -> float:
    """
    stddev / mean of per-sentence word counts, capped at 1.0.

    Bursty writing (alternating short and long sentences) scores higher.
    Uniform sentence length (typical of AI) scores lower.
    Returns 0.0 if fewer than 2 sentences are found.
    """
    parts = _SENTENCE_SPLIT.split(text.strip())
    sentences = [s.strip() for s in parts if s.strip()]
    if len(sentences) < 2:
        return 0.0

    lengths = [len(s.split()) for s in sentences]
    n = len(lengths)
    mean = sum(lengths) / n
    if mean == 0.0:
        return 0.0

    variance = sum((x - mean) ** 2 for x in lengths) / n
    stddev = math.sqrt(variance)
    return min(stddev / mean, 1.0)


def _length_appropriateness_score(word_count: int) -> float:
    """
    Ideal range: 150–300 words → 1.0
    Acceptable:  100–149 or 301–500 words → 0.7
    Outside:     < 100 or > 500 words → 0.3
    """
    if 150 <= word_count <= 300:
        return 1.0
    if 100 <= word_count <= 500:
        return 0.7
    return 0.3
