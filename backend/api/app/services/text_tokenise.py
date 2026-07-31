"""
Shared tokeniser for the deterministic (no-AI) keyword-overlap matchers —
story_matcher.py (Phase 10.2.b) and fact_selector.py (Phase 10.3), which
follow the same "lowercase alpha tokens, stop-words removed" pattern to
score keyword overlap between a query and candidate text.
"""
from __future__ import annotations

import re

# English function words only. Industry terms (e.g. "led", "built") are
# intentionally excluded so they contribute to matching signals.
STOP_WORDS: frozenset[str] = frozenset({
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


def tokenise(text: str) -> frozenset[str]:
    """Lowercase alpha tokens, >=3 chars, stop-words removed."""
    tokens = re.findall(r"[a-z]{3,}", text.lower())
    return frozenset(t for t in tokens if t not in STOP_WORDS)
