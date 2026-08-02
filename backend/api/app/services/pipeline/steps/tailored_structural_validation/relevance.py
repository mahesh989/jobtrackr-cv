"""JD vocabulary building and token-overlap relevance checks.

Split out of the former single-module tailored_structural_validation.py
(1,270 lines). Pure code motion — function bodies, ordering and comments are
unchanged. ``run_tailored_structural_validation`` remains importable from
``app.services.pipeline.steps.tailored_structural_validation``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple
from app.enums import BUCKET_KEYS, CATEGORY_KEYS
import re

# ---------------------------------------------------------------------------
# Relevance gates — use JD vocabulary to flag off-topic Education / Projects
# ---------------------------------------------------------------------------

# Glue words and obvious noise — these are filtered before checking
# overlap. We deliberately keep "data", "analytics", "science",
# "engineering" etc. IN play because those ARE the signal that establishes
# field relevance (Master of Data Science vs. a data-analytics JD).
# Over-pruning the vocabulary causes false-positive "irrelevant" warnings
# on the candidate's most important credentials.
_RELEVANCE_STOPWORDS = frozenset({
    "the", "and", "of", "in", "for", "with", "a", "an", "on", "to",
    "is", "as", "at", "by", "or", "from", "into", "onto", "via",
    "applied", "general", "studies", "study", "modern", "advanced",
    "introduction", "fundamentals",
})

# Stems we consider domain-equivalent — extends literal token matching
# so "marketing" matches "marketers", "fundrais" covers fundraising/er.
_RELEVANCE_PREFIX_LEN = 5


def _normalise_token(tok: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", tok.lower())


def _tokenise_for_relevance(text: str) -> List[str]:
    """Lowercased alphanumeric tokens, stopwords removed."""
    return [
        t for t in (
            _normalise_token(w) for w in re.split(r"\s+", text or "")
        )
        if t and len(t) >= 3 and t not in _RELEVANCE_STOPWORDS
    ]


def _build_jd_vocabulary(jd_analysis: Dict[str, Any]) -> set[str]:
    """
    Flatten the JD analysis into a set of relevance tokens.

    Reads keywords.required.* and keywords.preferred.* across all three
    categories (technical / soft_skills / domain_knowledge) plus role
    title / industry hints if present. Tokenised the same way as
    `_tokenise_for_relevance` so the comparison is apples-to-apples.
    """
    bag: set[str] = set()
    if not jd_analysis:
        return bag

    keywords = jd_analysis.get("keywords") or {}
    for bucket in BUCKET_KEYS:
        cats = keywords.get(bucket) or {}
        for cat in CATEGORY_KEYS:
            for kw in cats.get(cat) or []:
                bag.update(_tokenise_for_relevance(str(kw)))

    # Role title and industry context
    for field in ("role_title", "primary_domain", "industry"):
        v = jd_analysis.get(field)
        if isinstance(v, str):
            bag.update(_tokenise_for_relevance(v))

    bag.discard("")
    return bag


def _has_overlap(tokens: List[str], jd_vocab: set[str]) -> List[str]:
    """Return the subset of `tokens` that share a prefix with any JD token."""
    if not jd_vocab:
        return []
    matches: List[str] = []
    for t in tokens:
        if t in jd_vocab:
            matches.append(t)
            continue
        # Prefix match on the first N characters — covers stem variants.
        head = t[:_RELEVANCE_PREFIX_LEN]
        if any(v.startswith(head) or head.startswith(v[:_RELEVANCE_PREFIX_LEN])
               for v in jd_vocab):
            matches.append(t)
    return matches
