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
# S5 — ATS-readiness (research-grounded)
#
# Reflects how real ATS actually gate candidates (see the ATS research):
#   • Keyword coverage (55) — fraction of JD required/preferred terms present
#     LEXICALLY in the CV (exact/word-boundary — what recruiter boolean search
#     and ranking actually key on), and GROUNDED in the original CV so
#     fabrications earn nothing. Required weighted 3:1 over preferred.
#   • Parseability (30) — the #1 mechanical risk: standard section headings,
#     contact info present, sane length. (A clean tailored CV beats a styled,
#     column-heavy original here — the honest, demonstrable lift.)
#   • Section completeness (15) — the expected sections exist.
# ---------------------------------------------------------------------------

import re as _re  # already imported at top; alias kept local-safe

_STD_SECTIONS = ("experience", "education", "skills")
_EMAIL_RE = _re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_PHONE_RE = _re.compile(r"(\+?\d[\d\s\-().]{6,}\d)")


def _collect_jd_terms(jd_analysis: Dict[str, Any], block: str) -> List[str]:
    out: List[str] = []
    cats = (jd_analysis or {}).get(block) or {}
    if isinstance(cats, dict):
        for cat in _CATEGORIES:
            out.extend(str(x).lower().strip() for x in (cats.get(cat) or []) if str(x).strip())
    # dedupe preserve order
    seen: set[str] = set()
    return [t for t in out if not (t in seen or seen.add(t))]


def _coverage_rate(
    terms: List[str], cv_lower: str, orig_lower: Optional[str], ev: Dict[str, str],
) -> float:
    if not terms:
        return 1.0  # JD asked for nothing in this bucket — don't penalise
    hit = 0
    for t in terms:
        if not _kw_present(t, cv_lower):
            continue
        # Ground against the original so fabricated terms earn no coverage.
        if orig_lower is not None and not _is_grounded(t, orig_lower, ev):
            continue
        hit += 1
    return hit / len(terms)


def _parseability(cv_text: str) -> float:
    """0-30: standard headings (15) + contact (8) + sane length (7)."""
    low = (cv_text or "").lower()
    pts = 0.0
    pts += 5.0 * sum(1 for s in _STD_SECTIONS if s in low)        # up to 15
    if _EMAIL_RE.search(cv_text or ""):
        pts += 4.0
    if _PHONE_RE.search(cv_text or ""):
        pts += 4.0
    wc = len((cv_text or "").split())
    if 150 <= wc <= 1200:
        pts += 7.0
    elif 80 <= wc < 150 or 1200 < wc <= 2000:
        pts += 4.0
    return min(pts, 30.0)


def _scorer_s5_ats_readiness(
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    *,
    original_cv_text: Optional[str] = None,
) -> Dict[str, Any]:
    cv_lower = (cv_text or "").lower()
    orig_lower = (original_cv_text or "").lower() if original_cv_text is not None else None

    raw_ev = (matching.get("match_evidence") or {}) if isinstance(matching, dict) else {}
    ev = {
        str(k).lower().strip(): str(v).lower().strip()
        for k, v in (raw_ev.items() if isinstance(raw_ev, dict) else [])
        if str(k).strip() and str(v).strip()
    }

    req = _collect_jd_terms(jd_analysis, "required_skills")
    pref = _collect_jd_terms(jd_analysis, "preferred_skills")
    req_rate = _coverage_rate(req, cv_lower, orig_lower, ev)
    pref_rate = _coverage_rate(pref, cv_lower, orig_lower, ev)

    coverage_pts = (req_rate * 0.75 + pref_rate * 0.25) * 55.0
    parse_pts = _parseability(cv_text)
    sections_present = sum(1 for s in _STD_SECTIONS if s in cv_lower)
    completeness_pts = (sections_present / len(_STD_SECTIONS)) * 15.0

    overall = int(round(coverage_pts + parse_pts + completeness_pts))
    overall = max(0, min(100, overall))

    return {
        "overall_score": overall,
        "ats_readiness_breakdown": {
            "keyword_coverage": {
                "earned": round(coverage_pts, 1), "max": 55,
                "required_rate_pct": round(req_rate * 100, 1),
                "preferred_rate_pct": round(pref_rate * 100, 1),
                "required_total": len(req), "preferred_total": len(pref),
            },
            "parseability": {"earned": round(parse_pts, 1), "max": 30},
            "section_completeness": {"earned": round(completeness_pts, 1), "max": 15},
        },
    }


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


SCORER_VARIANTS: Dict[str, ScorerFn] = {
    "s1_current":      _scorer_s1_current,
    "s2_grounded":     _scorer_s2_grounded,
    "s5_ats_readiness": _scorer_s5_ats_readiness,
}


def get_scorer(scorer_variant: str) -> ScorerFn:
    fn = SCORER_VARIANTS.get(scorer_variant)
    if fn is None:
        raise ValueError(
            f"Unknown scorer_variant '{scorer_variant}'. "
            f"Known: {sorted(SCORER_VARIANTS)}"
        )
    return fn
