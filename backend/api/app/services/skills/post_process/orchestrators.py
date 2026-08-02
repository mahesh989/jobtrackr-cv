"""Top-level entry points composing the post-processing stages.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from app.services.skills.classifier import (
    is_noise,
)
# Order matters here — the JD/CV pipeline emits skill dicts with these keys.
from app.enums import CATEGORY_KEYS as _CATEGORIES
# role_family.id → lexicon vertical.  Single source of truth lives in the
# verticals registry; imported here to eliminate the drift risk.
from app.services.verticals import FAMILY_TO_LEXICON as _ROLE_FAMILY_TO_VERTICAL
from ._common import logger
from .core import (
    _empty_sidecar,
    post_process_skills,
)
from .credentials import (
    _build_credentials_block,
    _build_job_context,
    _demote_conditional_required_to_preferred,
)
from .subsumption import (
    _collapse_children_to_parent,
    _dedupe_by_subsumption,
)

def post_process_jd_analysis(
    jd_analysis: Dict[str, Any],
    *,
    role_family_id: str,
) -> Dict[str, Any]:
    """Apply lexicon post-processing to a complete JD-analysis result.

    Mutates a shallow copy: ``required_skills`` and ``preferred_skills``
    are replaced with the lexicon-cleaned versions, and a new
    ``lexicon_meta`` field is attached containing the per-bucket
    sidecar (for downstream routing and diagnostics).

    Runs the conditional-clause demoter FIRST so any "X or willingness to
    apply" required entries are moved to preferred BEFORE per-bucket
    classification / dedup runs. Subsumption dedup runs LAST so it sees
    the final canonicalised set.
    """
    # Demote conditional REQUIRED entries to PREFERRED — must run before
    # post_process_skills() because the demoter moves entries BETWEEN buckets
    # (required ↔ preferred), which the per-bucket cleaner can't do.
    jd_analysis = _demote_conditional_required_to_preferred(jd_analysis)

    out = dict(jd_analysis)  # shallow copy — JSON-roundtrippable anyway

    req_clean, req_side = post_process_skills(
        out.get("required_skills") or {}, role_family_id=role_family_id,
    )
    pref_clean, pref_side = post_process_skills(
        out.get("preferred_skills") or {}, role_family_id=role_family_id,
    )

    out["required_skills"] = req_clean
    out["preferred_skills"] = pref_clean

    vertical = _ROLE_FAMILY_TO_VERTICAL.get(role_family_id)
    # Roll up specific children → parent canonical when ≥2 specific siblings
    # appear without their umbrella term ("showering and bathing", "dressing
    # and grooming" → "personal care"). Runs BEFORE dedup so the new parent
    # entry has a chance to participate in subsequent passes.
    out, rolled_up = _collapse_children_to_parent(out, vertical)
    out, subsumed = _dedupe_by_subsumption(out, vertical)

    # Cross-bucket dedup — same canonical (case-insensitive) in both
    # required and preferred means the LLM emitted it twice from two
    # different bits of JD prose. Required wins; drop the preferred copy.
    # Same category required.
    req_blk = dict(out.get("required_skills") or {})
    pref_blk = dict(out.get("preferred_skills") or {})
    cross_dropped: List[str] = []
    for cat in _CATEGORIES:
        req_lower = {s.lower() for s in (req_blk.get(cat) or []) if isinstance(s, str)}
        if not req_lower:
            continue
        kept_pref: List[str] = []
        for s in (pref_blk.get(cat) or []):
            if isinstance(s, str) and s.lower() in req_lower:
                cross_dropped.append(f"{cat}:{s}")
                continue
            kept_pref.append(s)
        pref_blk[cat] = kept_pref
    if cross_dropped:
        out["preferred_skills"] = pref_blk
        logger.info(
            "cross-bucket dedup: dropped %d duplicate(s) from preferred "
            "(already present in required): %s",
            len(cross_dropped), cross_dropped,
        )

    # Preserve any prior lexicon_meta entries (e.g. ``ungrounded`` written
    # by verify_skill_evidence). Merging instead of overwriting keeps the
    # full diagnostic trail visible downstream.
    prior_meta = dict(jd_analysis.get("lexicon_meta") or {})
    prior_meta.update({
        "role_family": role_family_id,
        "vertical": vertical,
        "required": req_side,
        "preferred": pref_side,
        "subsumed": subsumed,
    })
    out["lexicon_meta"] = prior_meta

    # Surface credentials and job-context as first-class output fields so
    # the UI and future ATS scorer can consume them without digging into
    # lexicon_meta internals.
    out["credentials"] = _build_credentials_block(req_side, pref_side)
    out["job_context"] = _build_job_context(req_side, pref_side)

    # Single concise log line summarising what changed. Useful when
    # something looks off in a production run — quick to spot whether
    # the lexicon dropped/moved anything material.
    n_dropped = (len(req_side["credential"]) + len(req_side["eligibility"]) + len(req_side["noise"])
                 + len(pref_side["credential"]) + len(pref_side["eligibility"]) + len(pref_side["noise"]))
    n_moved = len(req_side["moved"]) + len(pref_side["moved"])
    n_unknown = len(req_side["unknown"]) + len(pref_side["unknown"])
    if n_dropped or n_moved or n_unknown:
        logger.info(
            "lexicon post-process (family=%s): dropped %d non-skill, moved %d, %d unknown",
            role_family_id, n_dropped, n_moved, n_unknown,
        )

    return out


def post_process_cv_skills(
    cv_skills: Dict[str, Any],
) -> Tuple[Dict[str, List[str]], Dict[str, list]]:
    """CV-side variant: apply ONLY the universal-noise filter.

    The CV categoriser produces buckets without knowing the vertical
    (it's run at upload time, no JD context). Applying a vertical
    lexicon here would require guessing the candidate's primary
    vertical — the LLM already does a decent job on the CV side
    (current symptom of the bug is on the JD side). So we just strip
    universal noise (credentials/eligibility/values) and trust the
    LLM's bucketing. Dedupes case-insensitively.

    Sidecar shape matches ``post_process_skills`` (credentials /
    eligibility / noise populated; moved + unknown stay empty
    because no vertical lexicon was applied).
    """
    cleaned: Dict[str, List[str]] = {c: [] for c in _CATEGORIES}
    sidecar = _empty_sidecar()
    seen: set = set()
    for cat in _CATEGORIES:
        items = cv_skills.get(cat) or []
        if not isinstance(items, list):
            continue
        for raw in items:
            if not isinstance(raw, str):
                continue
            phrase = raw.strip()
            if not phrase:
                continue
            nt = is_noise(phrase)
            if nt is not None:
                sidecar[nt].append(phrase)
                continue
            key = (phrase.lower(), cat)
            if key in seen:
                continue
            seen.add(key)
            cleaned[cat].append(phrase)
    return cleaned, sidecar
