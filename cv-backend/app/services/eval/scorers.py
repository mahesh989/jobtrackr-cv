"""
ATS scorer variant registry (Track S).

A scorer is a callable:

    score(cv_text, jd_analysis, matching, *, original_cv_text=None) -> ats_dict

where ats_dict has at least {"overall_score": int, ...} (the shape returned by
run_ats_scoring).

The runner calls the SAME scorer for both the initial CV and the tailored CV
so the two scores are comparable. For the TAILORED scoring it passes the
original CV via `original_cv_text` — scorers that care about grounding
(S2) use it to filter out matched-but-ungrounded keywords; S1 ignores it.

Variants:
  S1 current   — production deterministic 50/35/15. Credits any matched keyword.
  S2 grounded  — same scoring weights, but a keyword only counts as "matched"
                 if it's literally traceable to the ORIGINAL CV (either the
                 keyword itself appears, or the match_evidence phrase does).
                 Kills fabrication-as-lift: an injected keyword that the
                 candidate doesn't actually have stops inflating the score.

S3 / S4 plug in here later.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

from app.services.pipeline.steps.ats_scoring import run_ats_scoring
from app.services.pipeline.steps.cv_jd_matching import (
    _compute_counts,
    _compute_match_rates,
)

# Signature: (cv_text, jd_analysis, matching, *, original_cv_text=None) -> ats_dict
ScorerFn = Callable[..., Dict[str, Any]]

_BUCKETS = ("required", "preferred")
_CATEGORIES = ("technical", "soft_skills", "domain_knowledge")


# ---------------------------------------------------------------------------
# S1 — current production deterministic ATS
# ---------------------------------------------------------------------------


def _scorer_s1_current(
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    *,
    original_cv_text: Optional[str] = None,  # ignored — kept for signature symmetry
) -> Dict[str, Any]:
    return run_ats_scoring(cv_text, jd_analysis, matching)


# ---------------------------------------------------------------------------
# S2 — grounded ATS (only credits CV-traceable keywords)
# ---------------------------------------------------------------------------


def _kw_present(keyword: str, text_lower: str) -> bool:
    """Word-boundary check on word-character keywords; substring otherwise."""
    kw = (keyword or "").lower().strip()
    if not kw:
        return False
    if re.fullmatch(r"[\w\s\-]+", kw):
        return re.search(r"\b" + re.escape(kw) + r"\b", text_lower) is not None
    return kw in text_lower


def _is_grounded(
    keyword: str,
    original_lower: str,
    evidence_map_lower: Dict[str, str],
) -> bool:
    """
    A keyword is grounded if:
      (a) it appears literally in the original CV (word boundary), OR
      (b) the AI provided a match_evidence phrase for it AND that phrase
          appears literally in the original CV.

    Aliases that the AI legitimately matched via match_evidence (e.g.
    "stakeholder management" backed by "presented findings to leadership")
    survive — we just verify the evidence phrase is real.
    """
    kw = (keyword or "").lower().strip()
    if not kw:
        return False
    if _kw_present(kw, original_lower):
        return True
    phrase = evidence_map_lower.get(kw)
    if phrase and phrase in original_lower:
        return True
    return False


def _filter_to_grounded(
    matching: Dict[str, Any],
    jd_analysis: Dict[str, Any],
    original_cv_text: str,
) -> Dict[str, Any]:
    """Drop ungrounded entries from matching.matched, recompute counts/rates."""
    original_lower = (original_cv_text or "").lower()
    raw_ev = (matching.get("match_evidence") or {}) if isinstance(matching, dict) else {}
    evidence_map_lower: Dict[str, str] = {
        str(k).lower().strip(): str(v).lower().strip()
        for k, v in (raw_ev.items() if isinstance(raw_ev, dict) else [])
        if str(k).strip() and str(v).strip()
    }

    src_matched = (matching.get("matched") or {}) if isinstance(matching, dict) else {}
    new_matched: Dict[str, Dict[str, List[str]]] = {
        b: {c: [] for c in _CATEGORIES} for b in _BUCKETS
    }
    for bucket in _BUCKETS:
        bucket_block = (src_matched.get(bucket) or {}) if isinstance(src_matched, dict) else {}
        for cat in _CATEGORIES:
            for kw in (bucket_block.get(cat) or []):
                if _is_grounded(str(kw), original_lower, evidence_map_lower):
                    new_matched[bucket][cat].append(str(kw).lower().strip())

    out = dict(matching or {})
    out["matched"] = new_matched
    out["counts"] = _compute_counts(new_matched, jd_analysis)
    out["match_rates"] = _compute_match_rates(out["counts"])
    return out


def _scorer_s2_grounded(
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    *,
    original_cv_text: Optional[str] = None,
) -> Dict[str, Any]:
    # If no original is supplied (initial-ATS call when cv_text already IS
    # the original), we still apply the grounding filter against cv_text —
    # this verifies the matching step's claims even for the initial score.
    grounding_source = original_cv_text if original_cv_text is not None else cv_text
    grounded = _filter_to_grounded(matching, jd_analysis, grounding_source)
    return run_ats_scoring(cv_text, jd_analysis, grounded)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


SCORER_VARIANTS: Dict[str, ScorerFn] = {
    "s1_current":   _scorer_s1_current,
    "s2_grounded":  _scorer_s2_grounded,
}


def get_scorer(scorer_variant: str) -> ScorerFn:
    fn = SCORER_VARIANTS.get(scorer_variant)
    if fn is None:
        raise ValueError(
            f"Unknown scorer_variant '{scorer_variant}'. "
            f"Known: {sorted(SCORER_VARIANTS)}"
        )
    return fn
