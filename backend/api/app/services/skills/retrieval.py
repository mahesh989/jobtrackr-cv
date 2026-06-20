"""Lexicon-based skill candidate retrieval for the validator LLM path.

Scans cleaned JD text with overlapping n-grams and collects candidate
skills from the vertical lexicon via the existing classifier.  The
resulting list is sent to the LLM so it validates presence rather than
extracting from a blank slate.

Usage:
    candidates = retrieve_skill_candidates(jd_text, "nursing")
    # → [{"canonical": "wound care", "category": "domain_knowledge",
    #      "vertical": "nursing"}, ...]
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from app.services.skills.classifier import (
    VerticalT,
    _VERTICAL_LOOKUPS,
    _VERTICALS,
    classify,
    normalise,
)

_SENTENCE_SEP = re.compile(r"[.!?\n]+")
_WS = re.compile(r"\s+")

_MAX_NGRAM_WORDS = 5


def _sentences(text: str) -> List[str]:
    parts = _SENTENCE_SEP.split(text)
    return [p.strip() for p in parts if p.strip()]


def _ngrams(sentence: str, max_n: int = _MAX_NGRAM_WORDS) -> List[str]:
    words = _WS.split(sentence.strip())
    out: List[str] = []
    for n in range(1, min(max_n, len(words)) + 1):
        for i in range(len(words) - n + 1):
            out.append(" ".join(words[i : i + n]))
    return out


def retrieve_skill_candidates(
    jd_text: str,
    vertical: Optional[str],
    *,
    top_k: int = 40,
) -> List[Dict[str, str]]:
    """Return up to ``top_k`` skill candidates from the lexicon that appear
    (exactly or by normalised key) in ``jd_text``.

    Strategy
    --------
    1. Split JD text into sentences.
    2. Emit overlapping 1-to-5-word n-grams per sentence.
    3. For each n-gram, run exact/normalised lookup only (no difflib fuzzy —
       we want high-precision candidates the LLM can anchor on, not guesses).
    4. Collect unique canonicals across all verticals relevant to this role:
       the named ``vertical`` first (if any), then the remaining two as
       cross-vertical fallback (tech canonicals sometimes appear in nursing
       JDs and vice-versa).
    5. Deduplicate by canonical name, preserving first-seen vertical.
    6. Order: domain_knowledge → technical → soft_skills (richer signal first).
    7. Cap at ``top_k``.

    Returns a list of dicts: ``{"canonical": str, "category": str,
    "vertical": str}``.
    """
    if not jd_text or not jd_text.strip():
        return []

    # Build priority list of verticals to scan.
    v_norm: Optional[VerticalT] = None
    if vertical and vertical.lower() in _VERTICALS:
        v_norm = vertical.lower()  # type: ignore[assignment]

    v_order: List[VerticalT] = []
    if v_norm:
        v_order.append(v_norm)
    for v in _VERTICALS:
        if v != v_norm:
            v_order.append(v)

    # Collect candidates: canonical_lower → {canonical, category, vertical}
    seen_canonical: Dict[str, Dict[str, str]] = {}

    text_lower = jd_text.lower()
    for sent in _sentences(text_lower):
        for ng in _ngrams(sent):
            norm_ng = normalise(ng)
            if not norm_ng or len(norm_ng) < 3:
                continue
            for v in v_order:
                lookup = _VERTICAL_LOOKUPS.get(v, {})
                hit = lookup.get(norm_ng)
                if hit is None:
                    continue
                canon, cat = hit
                key = canon.lower()
                if key not in seen_canonical:
                    seen_canonical[key] = {
                        "canonical": canon,
                        "category": cat,
                        "vertical": v,
                    }
                break  # prefer first-matching vertical for this ngram

    # Sort by category priority, then alphabetically within category.
    _CATEGORY_ORDER = {"domain_knowledge": 0, "technical": 1, "soft_skills": 2}
    candidates = sorted(
        seen_canonical.values(),
        key=lambda c: (_CATEGORY_ORDER.get(c["category"], 9), c["canonical"]),
    )

    return candidates[:top_k]
