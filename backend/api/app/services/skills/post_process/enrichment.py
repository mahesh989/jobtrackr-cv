"""JD-body lexicon scan — surface canonical skills the LLM missed.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from app.services.skills.classifier import (
    _VERTICAL_LOOKUPS,
    classify,
)
# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES
# role_family.id → lexicon vertical.  Single source of truth lives in the
# verticals registry; imported here to eliminate the drift risk.
from app.services.verticals import FAMILY_TO_LEXICON as _ROLE_FAMILY_TO_VERTICAL
from ._common import logger
from .credentials import (
    _CREDENTIAL_COMPONENT_LABELS,
    _is_setting_descriptor,
)

# ---------------------------------------------------------------------------
# JD-body lexicon scan — surface canonical care/domain skills the LLM missed.
# ---------------------------------------------------------------------------
#
# The JD analysis prompt is IT-centric (its only `domain_knowledge` examples
# are GDPR / data warehouse / IFRS / agile / B2B SaaS). On a prose-heavy
# nursing JD that says "support residents with daily personal care and
# companionship" in RESPONSIBILITIES, the LLM frequently fails to extract
# "personal care", "companionship", "aged care" etc. into
# required_skills.domain_knowledge.
#
# That empty bucket combined with the presence-aware ATS redistribution
# (commits 1dbf4a6 + 8c87f56) makes nursing scores swing 20+ points based on
# AI variance alone — same JD, same CV, different runs.
#
# This deterministic scan closes the variance by surfacing any nursing-
# lexicon canonical that literally appears in jd_text / summary /
# responsibilities. Canonicals already extracted under any bucket are
# skipped. Capped to keep below the JD schema's 10-per-bucket ceiling.
#
# Vertical-gated — only fires for verticals with a curated lexicon (today:
# nursing/tech/cleaning). Tech JDs rarely have this problem because the
# prompt's examples are IT-flavoured already; the scan is safe there too
# but mostly a no-op.

# Word characters that can occur INSIDE a lexicon phrase. Used to choose
# the boundary regex — `\b` is fine for plain words but the default behaviour
# treats hyphens as boundaries, which is correct here (we look up the literal
# phrase, hyphenated entries work because their internal '-' is matched
# literally and `\b` anchors at the outer ends).
_JD_BODY_SCAN_CAP: int = 10  # max canonicals to inject; mirrors schema limit
_MAX_PHRASE_TOKENS: int = 6  # skip very-long lexicon phrases (rarely literal)


# Coordination-expansion — "written and verbal communication" → expands to
# also include "written communication" and "verbal communication" as separate
# scannable phrases so the lexicon recall floor can match each modifier.
# Narrowly scoped to the communication modifier family to avoid false positives
# (e.g. "manual handling and infection control" must NOT expand).
_COORD_COMM_RE = re.compile(
    r"\b(written|verbal|oral|interpersonal)\s+and\s+(written|verbal|oral|interpersonal)"
    r"\s+(communication)\b",
    re.IGNORECASE,
)


def _expand_coordinated_modifiers(text: str) -> str:
    """Append expanded forms for coordinated communication modifiers.

    "written and verbal communication skills" → appends
    " written communication verbal communication" so both variants are
    reachable by a `\b…\b` regex search.
    """
    extras: List[str] = []
    for m in _COORD_COMM_RE.finditer(text):
        mod1, mod2, head = m.group(1), m.group(2), m.group(3)
        extras.append(f"{mod1.lower()} {head.lower()}")
        extras.append(f"{mod2.lower()} {head.lower()}")
    if extras:
        return text + " " + " ".join(extras)
    return text


def _scan_text(jd_text: str, summary: Optional[str], responsibilities: Any) -> str:
    """Combine jd_text + structured summary + responsibilities into one
    lowercase scannable blob. Unicode dash-likes are normalised to '-' so
    hyphenated lexicon canonicals match smart-punctuation JDs."""
    parts: List[str] = []
    if jd_text:
        parts.append(jd_text)
    if summary:
        parts.append(str(summary))
    if isinstance(responsibilities, list):
        parts.extend(str(r) for r in responsibilities if r)
    text = " ".join(parts).lower()
    # Normalise unicode dash variants (matches classifier.normalise)
    for ch in "‐‑‒–—−":
        text = text.replace(ch, "-")
    # Expand coordinated communication modifiers so "written and verbal
    # communication" also matches "written communication" in the lexicon scan.
    text = _expand_coordinated_modifiers(text)
    return text


def _already_extracted_canonicals(
    jd_analysis: Dict[str, Any], vertical: str
) -> set:
    """Return the set of CANONICAL forms (lowercased) already present in any
    of the LLM's extracted buckets, so the scan never re-adds something the
    LLM already surfaced (in any category, required or preferred)."""
    seen: set = set()
    for side_key in ("required_skills", "preferred_skills"):
        block = jd_analysis.get(side_key) or {}
        for cat in _CATEGORIES:
            for kw in (block.get(cat) or []):
                if not isinstance(kw, str):
                    continue
                c = classify(kw, vertical)  # type: ignore[arg-type]
                if c is not None and c.is_skill:
                    seen.add(c.canonical.lower())
                else:
                    seen.add(kw.strip().lower())
    return seen


# Per-bucket caps for the recall floor. Mirror the prompt schema's caps so
# we never push past what downstream consumers expect.
_BUCKET_CAPS: Dict[str, int] = {
    "technical":        15,
    "soft_skills":      10,
    "domain_knowledge": 10,
}


def enrich_required_skills_from_jd_body(
    jd_analysis: Dict[str, Any],
    jd_text: str,
    *,
    role_family_id: str,
    skill_text: Optional[str] = None,
) -> Dict[str, Any]:
    """Deterministic recall floor — surface canonical skills the LLM missed
    by scanning the JD body against the per-vertical lexicon.

    Scans ALL THREE buckets (technical / soft_skills / domain_knowledge),
    not just domain_knowledge. This is the safety net behind the JD-analysis
    LLM call: it stops the per-run variance ("got 7 skills this run, 2 next
    run") and stops paraphrase misses ("commitment to allocated shifts" →
    `reliability` is in the lexicon as a variant, so it always lands).

    Per-bucket cap matches the prompt schema (`_BUCKET_CAPS`). No-op when
    the role family has no curated vertical lexicon, when there is no text
    to scan, or when no new canonical matches.

    ``skill_text`` (optional): when supplied, the lexicon scan runs over this
    text instead of the full ``jd_text``. The orchestrator passes the
    pre-filtered JD (boilerplate sections stripped) so the recall floor no
    longer matches lexicon canonicals that appear only in About-Us / benefits
    / reporting-structure prose — the classic source of false positives like
    "reporting to registered nurse" or a provider's cross-service portfolio
    leaking into required skills. ``jd_text`` is retained for the no-op /
    presence guards and as the fallback when ``skill_text`` is empty.
    """
    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    if vertical is None:
        return jd_analysis

    text = _scan_text(
        skill_text if (skill_text and skill_text.strip()) else jd_text,
        jd_analysis.get("summary"),
        jd_analysis.get("responsibilities"),
    )
    if not text.strip():
        return jd_analysis

    already = _already_extracted_canonicals(jd_analysis, vertical)
    lookup = _VERTICAL_LOOKUPS.get(vertical) or {}  # type: ignore[arg-type]

    # Group by (bucket, canonical) so the first-matching variant wins and
    # we never consider the same canonical twice per bucket.
    by_bucket_canonical: Dict[str, Dict[str, List[str]]] = {
        cat: {} for cat in _CATEGORIES
    }
    for norm_phrase, (canonical, cat) in lookup.items():
        if cat not in _CATEGORIES:
            continue
        # Soft-skill recall is allowed ONLY when the canonical tokens are
        # literally present in the matched surface phrase (same word family).
        # Cross-family canonicalisation ("compassionate" → "empathy",
        # "flexible" → "adaptability") is still blocked by the token-subset
        # check applied in the injection loop below — so "written
        # communication" and "verbal communication" can be recalled while
        # "caring nature" → "empathy" cannot.
        canon_lower = canonical.lower()
        if canon_lower in already:
            continue
        # Skip sector / setting labels and credential components — the
        # post-process layer strips them from LLM extractions, so the
        # recall floor must not re-inject them via the vertical lexicon.
        if _is_setting_descriptor(canon_lower):
            continue
        if canon_lower in _CREDENTIAL_COMPONENT_LABELS:
            continue
        if len(norm_phrase.split()) > _MAX_PHRASE_TOKENS:
            continue
        by_bucket_canonical[cat].setdefault(canon_lower, []).append(norm_phrase)

    req_block = jd_analysis.get("required_skills") or {}
    new_req = dict(req_block)
    all_additions: Dict[str, List[str]] = {}

    for cat in _CATEGORIES:
        existing = list(req_block.get(cat) or [])
        slots = max(0, _BUCKET_CAPS[cat] - len(existing))
        if slots <= 0:
            continue
        additions: List[str] = []
        for canon_lower, phrases in by_bucket_canonical[cat].items():
            matched = next(
                (p for p in phrases if re.search(r"\b" + re.escape(p) + r"\b", text)),
                None,
            )
            if matched is None:
                continue
            # Soft-skill guard: only inject when canonical tokens are a subset
            # of the matched-phrase tokens (same word family). Blocks
            # cross-family canonicalisation ("compassionate" → "empathy").
            if cat == "soft_skills" and not set(canon_lower.split()).issubset(
                set(matched.split())
            ):
                continue
            additions.append(lookup[phrases[0]][0])
            if len(additions) >= slots:
                break
        if additions:
            new_req[cat] = (existing + additions)[: _BUCKET_CAPS[cat]]
            all_additions[cat] = additions

    if not all_additions:
        return jd_analysis

    out = dict(jd_analysis)
    out["required_skills"] = new_req

    # E2: write skill_evidence entries for injected canonicals so that
    # verify_skill_evidence (when require_evidence=True) doesn't drop them.
    # The matching phrase from the JD text is the evidence.
    existing_evidence: Dict[str, str] = dict(jd_analysis.get("skill_evidence") or {})
    for cat, additions in all_additions.items():
        for canon in additions:
            key = canon.strip().lower()
            if key not in existing_evidence:
                phrases = by_bucket_canonical[cat].get(key, [])
                matched_phrase = next(
                    (p for p in phrases if re.search(r"\b" + re.escape(p) + r"\b", text)),
                    phrases[0] if phrases else canon,
                )
                existing_evidence[key] = matched_phrase
    if existing_evidence != (jd_analysis.get("skill_evidence") or {}):
        out["skill_evidence"] = existing_evidence

    logger.info(
        "JD-body lexicon scan (vertical=%s, recall-floor): added %s",
        vertical,
        {cat: adds for cat, adds in all_additions.items() if adds},
    )
    return out
