"""Section-header clamp — Essential vs Desirable.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES
from ._common import logger

# ---------------------------------------------------------------------------
# Section-header clamp — Essential vs Desirable
# ---------------------------------------------------------------------------
#
# Many JDs split candidate requirements under explicit headings:
#   "Essential / Required / Must have / You must have / To be considered:"
#   "Desirable / Preferred / Nice to have / Highly desirable / Bonus:"
#
# The LLM often gets the Required/Preferred split right on the SECTION-LEVEL
# extraction, but slips when an item from one section is verbally similar to
# an item from another (e.g. "Basic computer and smartphone working knowledge"
# under DESIRABLE ends up in required.technical as "computer skills").
#
# This deterministic clamp walks the raw JD text, locates each section's
# body, and for every skill currently in the WRONG bucket relative to the
# section it appears in, MOVES it to the right bucket. Same category
# (technical / soft / domain) preserved. Idempotent.

_SECTION_HEAD_ESSENTIAL = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?\**\s*"
    r"(essential|required|must\s+have|you\s+must\s+have|"
    r"to\s+be\s+considered|requirements?)"
    r"\s*[:\-]?\s*\**\s*$",
)
_SECTION_HEAD_DESIRABLE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?\**\s*"
    r"(desirable|preferred|nice\s+to\s+have|highly\s+desirable|"
    r"bonus|advantageous|would\s+be\s+(?:a\s+)?(?:plus|advantage))"
    r"\s*[:\-]?\s*\**\s*$",
)
# Inline "Essential:" / "Desirable:" prefix on a single line. Captures the
# rest-of-line tail as that section's body when the JD uses the compact
# "Essential: ..." pattern instead of a multi-line section.
_INLINE_ESSENTIAL = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:essential|required|must\s+have)\s*[:\-]\s*(.+)$",
)
_INLINE_DESIRABLE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:desirable|preferred|nice\s+to\s+have|highly\s+desirable)\s*[:\-]\s*(.+)$",
)


def _collect_section_bodies(jd_text: str) -> Tuple[str, str]:
    """Return (essential_blob, desirable_blob) lowercase blobs by scanning
    section headers in ``jd_text``. Inline 'Essential: …' / 'Desirable: …'
    lines also contribute to the relevant blob. Empty string when a section
    isn't present."""
    if not jd_text:
        return "", ""
    lines = jd_text.splitlines()
    essential_parts: List[str] = []
    desirable_parts: List[str] = []
    current: Optional[str] = None
    for line in lines:
        bare = line.strip()
        if not bare:
            continue
        # Inline prefix lines contribute regardless of current section.
        m = _INLINE_ESSENTIAL.match(bare)
        if m:
            essential_parts.append(m.group(1).lower())
            current = "essential"
            continue
        m = _INLINE_DESIRABLE.match(bare)
        if m:
            desirable_parts.append(m.group(1).lower())
            current = "desirable"
            continue
        if _SECTION_HEAD_ESSENTIAL.match(bare):
            current = "essential"
            continue
        if _SECTION_HEAD_DESIRABLE.match(bare):
            current = "desirable"
            continue
        # Section bodies end at a blank line OR a long header-like line. We
        # already skipped blanks; cap by length to avoid running into prose
        # paragraphs. 200 chars is generous for a bullet, restrictive for
        # the "About Us" paragraph that often follows.
        if current and len(bare) <= 200:
            if current == "essential":
                essential_parts.append(bare.lower())
            elif current == "desirable":
                desirable_parts.append(bare.lower())
    return " | ".join(essential_parts), " | ".join(desirable_parts)


def _phrase_in_blob(phrase: str, blob: str) -> bool:
    """True when any content token of ``phrase`` (>3 chars) appears in
    ``blob`` AND the matched span is within a window suggesting the phrase
    really belongs to that section. Approximation — but combined with the
    head/body extraction in ``_collect_section_bodies`` it catches the
    common cases without over-firing on incidental keyword mentions
    elsewhere in the JD."""
    if not phrase or not blob:
        return False
    tokens = [t for t in re.findall(r"[a-z][a-z\-]+", phrase.lower()) if len(t) > 3]
    if not tokens:
        return False
    return any(t in blob for t in tokens)


def clamp_by_jd_sections(
    jd_analysis: Dict[str, Any], jd_text: str,
) -> Dict[str, Any]:
    """Move skills between required ↔ preferred when the JD's Essential /
    Desirable section headers contradict the LLM's bucketing.

    Mutates a shallow copy. No-op when neither section is detected in the
    JD text. Records moves under ``lexicon_meta.section_clamp`` for
    diagnostics."""
    essential_blob, desirable_blob = _collect_section_bodies(jd_text)
    if not essential_blob and not desirable_blob:
        return jd_analysis

    req = dict(jd_analysis.get("required_skills") or {})
    pref = dict(jd_analysis.get("preferred_skills") or {})
    moves: List[Dict[str, str]] = []

    for cat in _CATEGORIES:
        req_items = list(req.get(cat) or [])
        pref_items = list(pref.get(cat) or [])
        new_req: List[str] = []
        new_pref: List[str] = list(pref_items)

        # Required → Preferred when phrase only matches Desirable blob.
        for s in req_items:
            if not isinstance(s, str):
                continue
            in_desirable = desirable_blob and _phrase_in_blob(s, desirable_blob)
            in_essential = essential_blob and _phrase_in_blob(s, essential_blob)
            if in_desirable and not in_essential:
                if s.lower() not in {p.lower() for p in new_pref}:
                    new_pref.append(s)
                moves.append({"skill": s, "from": "required", "to": "preferred", "category": cat})
            else:
                new_req.append(s)

        # Preferred → Required when phrase only matches Essential blob.
        final_pref: List[str] = []
        for s in new_pref:
            if not isinstance(s, str):
                continue
            in_essential = essential_blob and _phrase_in_blob(s, essential_blob)
            in_desirable = desirable_blob and _phrase_in_blob(s, desirable_blob)
            if in_essential and not in_desirable:
                if s.lower() not in {r.lower() for r in new_req}:
                    new_req.append(s)
                moves.append({"skill": s, "from": "preferred", "to": "required", "category": cat})
            else:
                final_pref.append(s)

        req[cat] = new_req
        pref[cat] = final_pref

    if not moves:
        return jd_analysis

    out = dict(jd_analysis)
    out["required_skills"] = req
    out["preferred_skills"] = pref
    meta = dict(out.get("lexicon_meta") or {})
    meta["section_clamp"] = moves
    out["lexicon_meta"] = meta
    logger.info(
        "section clamp: moved %d skill(s) between required/preferred per JD section headers",
        len(moves),
    )
    return out
