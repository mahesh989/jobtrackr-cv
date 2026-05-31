"""
Step 6.5 — Tailored-CV re-scoring (deterministic).

After the tailored CV is generated, we want to verify — without another
AI call — whether the keywords the feasibility classifier APPROVED were
actually surfaced in the tailored markdown, and what the resulting ATS
score is.

Approach:
  1. For every keyword in feasibility_plan.inject_directly + .inject_as_extension,
     check whether it appears in the tailored CV text (case-insensitive
     substring on word-boundaries-ish — same level of fuzziness as the
     ATS step uses for section-name detection).
  2. Build a `tailored_matching` structure by taking the original
     `matching` and MOVING the verified keywords from `missed` to
     `matched`, then recomputing `counts` and `match_rates`.
  3. Run the deterministic ATS scorer on `(tailored_text, jd, tailored_matching)`.
  4. Report the lift.

Why deterministic?
  - It is honest. We only credit lift for keywords that LITERALLY appear
    in the tailored CV. If the AI failed to inject something, no credit.
  - It avoids a second cv_jd_matching AI call, halving the per-run cost
    and latency for this verification step.
  - It is reproducible by hand, which the user wants for ATS transparency.

Output:
    {
      "tailored_ats_scoring_result": {<full breakdown>, ...},
      "tailored_match_score":         int,         # 0-100
      "ats_lift":                     int,         # tailored - original
      "injected_keywords":            [str, ...],  # actually present in tailored
      "failed_to_inject":             [str, ...],  # approved but missing
      "honest_gaps":                  [str, ...],  # echo from feasibility
      "fabricated_keywords":          [str, ...],  # cannot_inject keywords that
                                                   # appeared in the tailored CV
                                                   # (prompt violation — should be empty)
    }
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Set, Tuple

from app.services.pipeline.steps.ats_scoring import (
    _FORMATTING_MAX,
    _to_pct,
    run_ats_scoring,
)
from app.services.pipeline.steps.cv_jd_matching import (
    _compute_counts,
    _compute_match_rates,
)

logger = logging.getLogger(__name__)


_BUCKETS = ("required", "preferred")
_CATEGORIES = ("technical", "soft_skills", "domain_knowledge")


def run_tailored_rescoring(
    tailored_markdown: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    feasibility: Dict[str, Any],
    original_ats: Dict[str, Any],
) -> Dict[str, Any]:
    plan = (feasibility or {}).get("feasibility_plan") or {}
    approved = _approved_keywords(plan)

    tailored_lower = (tailored_markdown or "").lower()

    # Honesty blocklist: keywords the feasibility classifier judged we cannot
    # legitimately claim. Surfacing one of these is a fabrication and is NEVER
    # credited toward the score.
    honest_gaps = [
        str(e.get("keyword") or "").lower().strip()
        for e in (plan.get("cannot_inject") or [])
        if isinstance(e, dict) and e.get("keyword")
    ]
    blocked: Set[str] = {kw for kw in honest_gaps if kw}

    # Credit EVERY missed JD keyword the tailored CV now surfaces literally,
    # except the honesty blocklist. Reacting to any genuine improvement — not
    # only the keywords the feasibility classifier happened to enumerate — is
    # what makes this generalise across every analysis. The promotion is
    # monotonic (missed → matched only): the tailored CV can never score below
    # the original on keyword coverage.
    all_missed = _all_missed_keywords(matching)
    credited: Set[str] = {
        kw for kw in all_missed
        if kw and kw not in blocked and _kw_present(kw, tailored_lower)
    }

    # Reporting split for the UI chips: which approved keywords actually landed
    # vs which the writer failed to surface.
    injected = sorted(credited)
    failed = sorted({kw for kw in approved if kw not in credited})

    # Build a tailored matching by promoting the credited keywords.
    tailored_matching = _promote_injections(matching, credited)

    # Recompute counts + rates against the JD as ground truth.
    tailored_matching["counts"] = _compute_counts(
        tailored_matching["matched"], jd_analysis
    )
    tailored_matching["match_rates"] = _compute_match_rates(
        tailored_matching["counts"]
    )

    # Deterministic ATS score on the tailored CV, using the SAME scorer and the
    # SAME (frozen) experience signal as the original. raw_match_score rides
    # through _promote_injections untouched, so Category 2 (experience) is
    # identical for original and tailored — honest tailoring surfaces keywords,
    # it does not add experience. Only keyword coverage moves.
    tailored_ats = run_ats_scoring(tailored_markdown, jd_analysis, tailored_matching)

    # Formatting is a property of the GENERATOR, not of tailoring quality. A
    # clean generated CV must never format worse than the raw original (which
    # can happen only as an artifact — e.g. contact info not stamped). Floor the
    # formatting component at the original's so such artifacts can't manufacture
    # a phantom regression; genuinely cleaner formatting is still rewarded.
    tailored_ats = _floor_formatting(tailored_ats, original_ats)

    original_score = int((original_ats or {}).get("overall_score") or 0)
    tailored_score = int(tailored_ats.get("overall_score") or 0)
    lift = tailored_score - original_score

    # Fabrication check — if any blocked keyword literally appears in the
    # tailored CV, the writer broke the honesty contract. Surface it so the
    # user can see what was wrongly added; it earns no points and doesn't fail
    # the run.
    fabricated: List[str] = sorted(
        {kw for kw in blocked if _kw_present(kw, tailored_lower)}
    )
    if fabricated:
        logger.warning(
            "Tailored CV contains %d fabricated keyword(s) from cannot_inject: %s",
            len(fabricated),
            fabricated,
        )

    return {
        "tailored_ats_scoring_result": tailored_ats,
        "tailored_match_score":         tailored_score,
        "ats_lift":                     lift,
        "injected_keywords":            injected,
        "failed_to_inject":             failed,
        "honest_gaps":                  honest_gaps,
        "fabricated_keywords":          fabricated,
        "tailored_matching":            tailored_matching,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _all_missed_keywords(matching: Dict[str, Any]) -> Set[str]:
    """Flatten matching['missed'] across every bucket × category to a lower-cased set."""
    missed = (matching or {}).get("missed") or {}
    out: Set[str] = set()
    if not isinstance(missed, dict):
        return out
    for bucket in _BUCKETS:
        b = missed.get(bucket) or {}
        if not isinstance(b, dict):
            continue
        for cat in _CATEGORIES:
            for kw in (b.get(cat) or []):
                k = str(kw).lower().strip()
                if k:
                    out.add(k)
    return out


def _floor_formatting(
    tailored_ats: Dict[str, Any], original_ats: Dict[str, Any]
) -> Dict[str, Any]:
    """Raise the tailored formatting component to at least the original's.

    Mutates and returns the tailored ATS dict: when the original formatted
    better, the shortfall is added back to the formatting component, the
    formatting_score percentage, and the overall_score. A no-op when the
    tailored CV already formats as well or better.
    """
    t_fmt = (tailored_ats.get("breakdown") or {}).get("category_3_formatting") or {}
    o_fmt = ((original_ats or {}).get("breakdown") or {}).get("category_3_formatting") or {}
    t_earned = float(t_fmt.get("earned") or 0.0)
    o_earned = float(o_fmt.get("earned") or 0.0)
    if o_earned <= t_earned:
        return tailored_ats

    delta = o_earned - t_earned
    t_fmt["earned"] = round(o_earned, 1)
    tailored_ats["formatting_score"] = _to_pct(o_earned, _FORMATTING_MAX)
    new_overall = int(round((tailored_ats.get("overall_score") or 0) + delta))
    tailored_ats["overall_score"] = max(0, min(100, new_overall))
    return tailored_ats


def _approved_keywords(plan: Dict[str, Any]) -> List[str]:
    """All keywords the feasibility classifier said are eligible to inject."""
    out: List[str] = []
    for fb in ("inject_directly", "inject_as_extension", "inject_with_inference"):
        for entry in plan.get(fb) or []:
            if not isinstance(entry, dict):
                continue
            kw = str(entry.get("keyword") or "").lower().strip()
            if kw:
                out.append(kw)
    # de-dup, preserve order
    seen: Set[str] = set()
    deduped: List[str] = []
    for kw in out:
        if kw not in seen:
            seen.add(kw)
            deduped.append(kw)
    return deduped


def _kw_present(keyword: str, text_lower: str) -> bool:
    """
    Detect a keyword in the tailored CV text.

    Uses a regex with `\b` word boundaries when the keyword contains
    only word characters (letters, digits, underscores). For multi-word
    or symbol-bearing keywords (e.g. "data warehouse", "c++"), falls back
    to plain substring search.
    """
    kw = keyword.lower().strip()
    if not kw:
        return False
    if re.fullmatch(r"[\w\s\-]+", kw):
        # \b boundaries on the first/last alphanumeric run
        pattern = r"\b" + re.escape(kw) + r"\b"
        return re.search(pattern, text_lower) is not None
    return kw in text_lower


def _promote_injections(
    matching: Dict[str, Any], injected: Set[str]
) -> Dict[str, Any]:
    """
    Return a new matching dict with `matched`/`missed` updated:
    every injected keyword is moved from missed → matched, in the
    same bucket × category it originated from.
    """
    src_matched = (matching or {}).get("matched") or {}
    src_missed  = (matching or {}).get("missed")  or {}

    new_matched: Dict[str, Dict[str, List[str]]] = {b: {c: [] for c in _CATEGORIES} for b in _BUCKETS}
    new_missed:  Dict[str, Dict[str, List[str]]] = {b: {c: [] for c in _CATEGORIES} for b in _BUCKETS}

    for bucket in _BUCKETS:
        m_bucket = (src_matched.get(bucket) or {}) if isinstance(src_matched, dict) else {}
        x_bucket = (src_missed.get(bucket)  or {}) if isinstance(src_missed,  dict) else {}
        for cat in _CATEGORIES:
            already_matched = list(m_bucket.get(cat) or [])
            still_missing:  List[str] = []
            promoted:       List[str] = []
            for kw in (x_bucket.get(cat) or []):
                k = str(kw).lower().strip()
                if k in injected:
                    promoted.append(k)
                else:
                    still_missing.append(k)
            new_matched[bucket][cat] = sorted(set(already_matched + promoted))
            new_missed[bucket][cat]  = sorted(set(still_missing))

    out = dict(matching or {})
    out["matched"] = new_matched
    out["missed"]  = new_missed
    return out
