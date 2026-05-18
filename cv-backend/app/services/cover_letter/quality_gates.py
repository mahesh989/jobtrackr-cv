"""
Deterministic quality gates for the cover letter pipeline.

No AI calls in this module — all checks are computed from the text itself.
These are used by generator.py after each relevant pass.

Gate 2 — Coherence: vocabulary overlap between letter and CV must exceed
a minimum threshold. A massive complexity gap between CV and letter is a
red flag for AI-ification.

Gate 3 — Statistical signature: burstiness (stddev/mean of sentence word
counts) must fall in the human-writing band [0.40, 1.20]. Too uniform →
sounds AI-generated; too erratic → sounds garbled.

Specificity check (part of Gate 3): the letter must contain at least one
concrete number, proper noun, or known-place pattern from the user's
experience.
"""
from __future__ import annotations

import math
import re
import string

# ── Thresholds ────────────────────────────────────────────────────────────────
# OPS-7: the 0.40 floor may be slightly high for short/uniform samples.
# Do not tune until 20+ real cover letter samples are available.
BURSTINESS_MIN = 0.40
BURSTINESS_MAX = 1.20
COHERENCE_MIN  = 0.15   # vocabulary overlap ratio floor

# Sentence splitter — handles common abbreviations well enough for a
# statistical check. Not perfect; edge cases (e.g. "Dr. Smith") will
# occasionally split wrong, but the aggregate stddev/mean is robust.
_SENT_RE = re.compile(r"(?<=[.!?])\s+")

# Specificity: a digit sequence (e.g. "35%", "2 million", "Q3 2025")
_HAS_NUMBER_RE = re.compile(r"\d")


def compute_burstiness(text: str) -> float:
    """
    Compute burstiness = stddev(sentence_lengths) / mean(sentence_lengths).

    Sentence length is measured in words (split on whitespace).

    Returns float('nan') when the text has fewer than 3 sentences — treated
    as a gate pass in the generator (not enough signal to penalise short texts).
    """
    sentences = [s.strip() for s in _SENT_RE.split(text) if s.strip()]
    if len(sentences) < 3:
        return float("nan")

    lengths = [len(s.split()) for s in sentences]
    mean = sum(lengths) / len(lengths)
    if mean == 0:
        return float("nan")

    variance = sum((l - mean) ** 2 for l in lengths) / len(lengths)
    stddev = math.sqrt(variance)
    return stddev / mean


def normalise_burstiness(burstiness: float) -> float:
    """
    Map raw burstiness to a [0, 1] naturalness score for the UI badge.

    The ideal human band is [BURSTINESS_MIN, BURSTINESS_MAX].
    Values inside the band map linearly to [0.5, 1.0].
    Values outside clamp to [0, 0.5].
    """
    if math.isnan(burstiness):
        return 0.75  # not enough data → neutral

    mid = (BURSTINESS_MIN + BURSTINESS_MAX) / 2  # 0.80
    half_range = (BURSTINESS_MAX - BURSTINESS_MIN) / 2  # 0.40

    if BURSTINESS_MIN <= burstiness <= BURSTINESS_MAX:
        # Distance from mid: 0 at centre → 1.0; at edges → 0.5
        distance_from_mid = abs(burstiness - mid)
        return 1.0 - (distance_from_mid / half_range) * 0.5
    else:
        # Outside band → proportional decay from 0.5 toward 0
        overshoot = min(
            abs(burstiness - BURSTINESS_MIN),
            abs(burstiness - BURSTINESS_MAX),
        )
        return max(0.0, 0.5 - overshoot * 0.5)


def compute_coherence_score(letter_text: str, cv_text: str) -> float:
    """
    Vocabulary overlap ratio between the letter and the CV.

    Uses type-token overlap: fraction of unique letter words that also appear
    in the CV. A score near 0 means the letter uses vocabulary absent from the
    CV — a signal that the model invented new register or concepts.

    Returns float in [0, 1]. Returns 1.0 if the letter is empty (degenerate
    case treated as pass to avoid blocking on edge cases).
    """
    def _tokens(text: str) -> set[str]:
        # Lowercase, strip punctuation, split on whitespace.
        translator = str.maketrans("", "", string.punctuation)
        return {
            w.lower().translate(translator)
            for w in text.split()
            if len(w) > 2  # skip short function words (a, an, I, etc.)
        }

    letter_vocab = _tokens(letter_text)
    if not letter_vocab:
        return 1.0

    cv_vocab = _tokens(cv_text)
    if not cv_vocab:
        return 0.0

    overlap = letter_vocab & cv_vocab
    return len(overlap) / len(letter_vocab)


def check_specificity(text: str) -> bool:
    """
    Return True if the letter contains at least one concrete anchor:
      - A digit sequence (numbers, percentages, years)
      - A title-cased word that appears mid-sentence (proxy for proper noun)

    This is a heuristic, not a semantic check. It catches the case where Pass 3
    has stripped all numbers and proper nouns, leaving a letter with no concrete
    grounding.
    """
    if _HAS_NUMBER_RE.search(text):
        return True

    # Look for any title-cased word after the first sentence (to avoid
    # sentence-openers inflating the count)
    sentences = [s.strip() for s in _SENT_RE.split(text) if s.strip()]
    for sent in sentences[1:]:  # skip first sentence — always has a capital
        words = sent.split()
        for word in words[1:]:  # skip sentence-opening word
            clean = word.strip(string.punctuation)
            if clean and clean[0].isupper() and len(clean) >= 3:
                return True

    return False
