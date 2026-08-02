"""Subsumption dedup — collapse child skills into their parent.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from app.services.skills.classifier import (
    _SUBSUMES,
)
# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES

# ---------------------------------------------------------------------------
# Phase 3 — subsumption dedup
# ---------------------------------------------------------------------------
#
# Some lexicon canonicals are GENERIC parents that the LLM extracts alongside
# one or more SPECIFIC children. Example: a nursing JD says "verbal and
# written communication" — the LLM happily emits all three of
# {communication, verbal communication, written communication}. The parent is
# pure redundancy: the children already say everything the parent says, with
# more specificity. Keeping the parent inflates the bucket and dilutes ATS
# match weight per item.
#
# The lexicon declares parent→children via the optional ``subsumes`` field
# on a canonical entry. ``_SUBSUMES`` in classifier.py loads those into
# ``{parent_canonical_lower: {child_canonical_lower, ...}}`` per vertical.
#
# Rule: within ONE bucket, if parent + ≥1 child are both present, drop the
# parent. Parent alone → kept. Cross-bucket presence (parent in required,
# child in preferred) is a deliberate non-action: those are different
# urgencies, not a redundancy.

# Parents where collapsing 2+ specific children → parent is recruiter-friendly
# (the parent is the term ATS / recruiters scan for and the specifics are
# micro-tasks that belong under the umbrella). Exclude:
#   • 'aged care' (children community/home/dementia/palliative are MAJOR care
#     types whose distinct signal matters)
#   • 'communication' (verbal vs written are recognised distinct soft skills
#     and tests + recruiters explicitly want both)
_ROLL_UP_PARENTS: frozenset = frozenset({
    "personal care",      # showering/bathing, dressing/grooming, toileting,
                          # feeding, continence — all ADL micro-tasks
    "care planning",      # individual planning process is just one variant
})


def _collapse_children_to_parent(
    jd_analysis: Dict[str, Any], vertical: Optional[str], *, min_children: int = 2,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Roll up ≥`min_children` specific canonicals into their umbrella parent
    when the parent itself is NOT present in the same bucket.

    Recruiter-friendly direction: an LLM that emits "showering and bathing",
    "dressing and grooming", "toileting assistance" gets a single canonical
    "personal care" — the term recruiters actually scan for. Limited via
    `_ROLL_UP_PARENTS` to canonicals where collapse is unambiguously good
    (excludes 'aged care' / 'communication' where children carry distinct
    signal worth preserving).
    """
    if vertical is None:
        return jd_analysis, []
    sub_map = _SUBSUMES.get(vertical) or {}  # type: ignore[arg-type]
    if not sub_map:
        return jd_analysis, []

    # parent → set(children_lower)
    rollups: List[Dict[str, Any]] = []
    out = dict(jd_analysis)

    for side in ("required_skills", "preferred_skills"):
        block = dict(out.get(side) or {})
        for cat in _CATEGORIES:
            items = list(block.get(cat) or [])
            if len(items) < min_children:
                continue
            present_lower = {s.strip().lower() for s in items if isinstance(s, str)}
            for parent_lower, children_lower in sub_map.items():
                if parent_lower not in _ROLL_UP_PARENTS:
                    continue          # opt-in list — most parents preserve children
                if parent_lower in present_lower:
                    continue          # parent already there — dedup handles it
                children_here = present_lower & children_lower
                if len(children_here) < min_children:
                    continue
                # Roll up: drop these children, insert the parent canonical.
                items = [s for s in items if isinstance(s, str) and s.strip().lower() not in children_here]
                items.append(parent_lower)
                present_lower = present_lower - children_here
                present_lower.add(parent_lower)
                rollups.append({
                    "side": side, "bucket": cat,
                    "parent": parent_lower,
                    "children_collapsed": sorted(children_here),
                })
            block[cat] = items
        out[side] = block

    return out, rollups


def _dedupe_by_subsumption(
    jd_analysis: Dict[str, Any], vertical: Optional[str],
) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """Drop generic parent canonicals when ≥1 child is in the same bucket.

    Returns ``(mutated_copy, removed)``. ``removed`` lists the drops as
    ``{bucket, side, parent, children_present}`` dicts for diagnostics.
    No-op when the vertical has no subsumption map or no entries to drop.
    """
    if vertical is None:
        return jd_analysis, []
    sub_map = _SUBSUMES.get(vertical) or {}  # type: ignore[arg-type]
    if not sub_map:
        return jd_analysis, []

    removed: List[Dict[str, str]] = []
    out = dict(jd_analysis)

    for side in ("required_skills", "preferred_skills"):
        block = dict(out.get(side) or {})
        for cat in _CATEGORIES:
            items = list(block.get(cat) or [])
            if not items:
                continue
            # Build a case-insensitive index of what's in this bucket.
            present_lower = {s.strip().lower() for s in items if isinstance(s, str)}
            kept: List[str] = []
            for s in items:
                if not isinstance(s, str):
                    continue
                key = s.strip().lower()
                children = sub_map.get(key)
                if children and (children & present_lower):
                    removed.append({
                        "side": side, "bucket": cat,
                        "parent": s,
                        "children_present": sorted(children & present_lower),
                    })
                    continue
                kept.append(s)
            block[cat] = kept
        out[side] = block

    return out, removed
