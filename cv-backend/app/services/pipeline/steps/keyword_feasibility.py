"""
Step 4.5 — Keyword Feasibility Classifier.

Decides, for every JD-required keyword that is currently MISSED in the
candidate's CV, whether it can be LEGITIMATELY surfaced in a tailored
version of the CV — and HOW.

This is the gate that prevents hallucination in the tailored CV step.
The downstream tailored-CV writer is allowed to inject only those
keywords this step puts in `inject_directly` or `inject_as_extension`.
Everything in `cannot_inject` becomes an "honest gap" the user is shown.

Output schema:

    {
      "feasibility_plan": {
        "inject_directly":       [<entry>, ...],
        "inject_as_extension":   [<entry>, ...],
        "inject_with_inference": [<entry>, ...],
        "cannot_inject":         [<entry>, ...]
      },
      "summary": {
        "n_inject_directly":       int,
        "n_inject_as_extension":   int,
        "n_inject_with_inference": int,
        "n_cannot_inject":         int,
        "expected_lift_pts":       float,   # estimated ATS-points gain if all
                                            # feasible keywords are injected
        "honest_gaps":             [str, ...]  # flat list, lowercase
      }
    }

Per-entry shape varies slightly by bucket — see
`KEYWORD_FEASIBILITY_SYSTEM` in prompts.py for the contract.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    KEYWORD_FEASIBILITY_SYSTEM,
    KEYWORD_FEASIBILITY_USER_TEMPLATE,
)

logger = logging.getLogger(__name__)


_BUCKETS = ("required", "preferred")
_CATEGORIES = ("technical", "soft_skills", "domain_knowledge")
_FEASIBILITY_BUCKETS = (
    "inject_directly",
    "inject_as_extension",
    "inject_with_inference",
    "cannot_inject",
)
_INJECTABLE_BUCKETS = (
    "inject_directly",
    "inject_as_extension",
    "inject_with_inference",
)
_VALID_CONFIDENCES = {"high", "medium"}
_VALID_TARGETS = {"skills_section", "summary", "experience_bullet"}

# Mirrors `_KEYWORD_WEIGHTS` in ats_scoring.py — kept local so the
# expected-lift estimate stays self-contained. If those weights change,
# update both places.
_KEYWORD_WEIGHTS = {
    "technical_required":        25,
    "soft_skills_required":      10,
    "domain_knowledge_required":  5,
    "preferred_overall":         10,
}


async def run_keyword_feasibility(
    client: AIClient,
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    input_recs: Dict[str, Any],
) -> Dict[str, Any]:
    missing_block = (input_recs or {}).get("missing_keywords") or {}
    match_evidence = (matching or {}).get("match_evidence") or {}

    # Fast-path: nothing to classify.
    if not _has_any_missing(missing_block):
        return _empty_plan()

    user_prompt = KEYWORD_FEASIBILITY_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_analysis_json=json.dumps(jd_analysis, indent=2),
        missing_keywords_json=json.dumps(
            {b: missing_block.get(b, {}) for b in _BUCKETS}, indent=2
        ),
        match_evidence_json=json.dumps(match_evidence, indent=2),
    )
    # Bumped from cv-magic's 2048 to 4096. Observed truncation on
    # verbose JDs (many keywords × per-entry evidence + suggested_rewrite
    # text). The AI client also retries on truncation as a safety net,
    # but raising the first-try ceiling avoids the extra round-trip in
    # the common case.
    raw = await client.complete_json(
        system=KEYWORD_FEASIBILITY_SYSTEM,
        user=user_prompt,
        max_tokens=4096,
        temperature=0.2,
    )

    plan = _normalise_plan(raw)
    plan = _reconcile_with_missing(plan, missing_block, matching=matching)

    # Counts and expected-lift summary
    counts = (matching or {}).get("counts") or {}
    expected_lift = _expected_lift_pts(plan, counts)

    summary = {
        "n_inject_directly":       len(plan["inject_directly"]),
        "n_inject_as_extension":   len(plan["inject_as_extension"]),
        "n_inject_with_inference": len(plan["inject_with_inference"]),
        "n_cannot_inject":         len(plan["cannot_inject"]),
        "expected_lift_pts":       round(expected_lift, 2),
        "honest_gaps":             [e["keyword"] for e in plan["cannot_inject"]],
    }

    return {"feasibility_plan": plan, "summary": summary}


# ---------------------------------------------------------------------------
# Normalisation + reconciliation
# ---------------------------------------------------------------------------


def _normalise_plan(raw: Any) -> Dict[str, List[Dict[str, Any]]]:
    """Coerce the AI response into the canonical 4-bucket shape."""
    out: Dict[str, List[Dict[str, Any]]] = {b: [] for b in _FEASIBILITY_BUCKETS}
    if not isinstance(raw, dict):
        return out

    for fb in _FEASIBILITY_BUCKETS:
        items = raw.get(fb)
        if not isinstance(items, list):
            continue
        for item in items:
            entry = _normalise_entry(item, feasibility=fb)
            if entry is not None:
                out[fb].append(entry)
    return out


def _normalise_entry(item: Any, *, feasibility: str) -> Dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    keyword = str(item.get("keyword") or "").lower().strip()
    if not keyword:
        return None

    category = str(item.get("category") or "").lower().strip()
    if category not in _CATEGORIES:
        return None
    bucket = str(item.get("bucket") or "").lower().strip()
    if bucket not in _BUCKETS:
        return None

    entry: Dict[str, Any] = {
        "keyword": keyword,
        "category": category,
        "bucket": bucket,
    }

    if feasibility == "cannot_inject":
        entry["reason"] = str(item.get("reason") or "").strip()
        return entry

    # inject_directly / inject_as_extension / inject_with_inference share most fields
    target = str(item.get("injection_target") or "").lower().strip()
    if target not in _VALID_TARGETS:
        target = "skills_section"
    entry["injection_target"] = target
    entry["evidence"] = str(item.get("evidence") or "").strip()
    entry["rationale"] = str(item.get("rationale") or "").strip()

    if feasibility == "inject_as_extension":
        entry["suggested_rewrite"] = str(item.get("suggested_rewrite") or "").strip()
    elif feasibility == "inject_with_inference":
        entry["suggested_rewrite"] = str(item.get("suggested_rewrite") or "").strip()
        # The inference chain is the user-visible justification — we keep
        # both the chain and the source phrases.
        chain = str(item.get("inference_chain") or "").strip()
        entry["inference_chain"] = chain
        inferred_from = item.get("inferred_from") or []
        if isinstance(inferred_from, list):
            entry["inferred_from"] = [
                str(p).strip() for p in inferred_from if str(p).strip()
            ]
        else:
            entry["inferred_from"] = []
        confidence = str(item.get("confidence") or "").lower().strip()
        if confidence not in _VALID_CONFIDENCES:
            confidence = "medium"
        entry["confidence"] = confidence

    return entry


def _reconcile_with_missing(
    plan: Dict[str, List[Dict[str, Any]]],
    missing_block: Dict[str, Dict[str, List[str]]],
    *,
    matching: Dict[str, Any],
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Make sure every missed keyword is accounted for exactly once.

    - Drop AI entries that reference keywords NOT in the missed set
      (the AI sometimes invents or duplicates entries).
    - Drop AI entries with empty evidence in inject_directly /
      inject_as_extension (no evidence = not eligible to inject).
    - Force any un-classified missed keyword into cannot_inject with
      a default reason. This guarantees `summary.honest_gaps` is truthful.
    """
    expected: Dict[str, Tuple[str, str]] = {}
    for bucket in _BUCKETS:
        cat_map = missing_block.get(bucket) or {}
        if not isinstance(cat_map, dict):
            continue
        for cat in _CATEGORIES:
            for kw in cat_map.get(cat) or []:
                k = str(kw).lower().strip()
                if k:
                    expected[k] = (bucket, cat)

    seen: set[str] = set()
    cleaned: Dict[str, List[Dict[str, Any]]] = {b: [] for b in _FEASIBILITY_BUCKETS}

    for fb in _FEASIBILITY_BUCKETS:
        for entry in plan[fb]:
            kw = entry["keyword"]
            if kw not in expected or kw in seen:
                continue
            # Force bucket+category to the JD's truth (don't trust the AI).
            entry["bucket"], entry["category"] = expected[kw]
            # No evidence? Demote to cannot_inject.
            if fb in _INJECTABLE_BUCKETS and not entry.get("evidence"):
                cleaned["cannot_inject"].append({
                    "keyword": kw,
                    "category": entry["category"],
                    "bucket":   entry["bucket"],
                    "reason":   "Classifier returned no CV evidence; demoted to honest gap.",
                })
            else:
                cleaned[fb].append(entry)
            seen.add(kw)

    # Anything missed but not classified → honest gap by default.
    for kw, (bucket, cat) in expected.items():
        if kw in seen:
            continue
        cleaned["cannot_inject"].append({
            "keyword": kw,
            "category": cat,
            "bucket":   bucket,
            "reason":   "Not addressed by classifier; defaulted to honest gap.",
        })

    return cleaned


# ---------------------------------------------------------------------------
# Expected-lift estimation
# ---------------------------------------------------------------------------


def _expected_lift_pts(
    plan: Dict[str, List[Dict[str, Any]]],
    counts: Dict[str, Any],
) -> float:
    """
    Estimate the ATS-points lift if every inject_directly + inject_as_extension
    keyword becomes a "matched" keyword.

    For each component (e.g. technical_required), the ATS step awards
    `(matched / total) * weight` points. Adding `delta` newly-matched
    keywords adds `(delta / total) * weight` to that component, capped at
    the component's max weight.
    """
    if not isinstance(counts, dict):
        return 0.0

    # Count proposed additions per (bucket, category).
    # Inference adds count too — the deterministic rescorer will only credit
    # them if they actually appear in the tailored CV, so this is an upper
    # bound on lift, not a guarantee.
    additions: Dict[Tuple[str, str], int] = {}
    for fb in _INJECTABLE_BUCKETS:
        for entry in plan[fb]:
            key = (entry["bucket"], entry["category"])
            additions[key] = additions.get(key, 0) + 1

    lift = 0.0

    # Required-bucket components — one weight per category.
    component_weight = {
        "technical":        _KEYWORD_WEIGHTS["technical_required"],
        "soft_skills":      _KEYWORD_WEIGHTS["soft_skills_required"],
        "domain_knowledge": _KEYWORD_WEIGHTS["domain_knowledge_required"],
    }
    req_counts = (counts.get("required") or {})
    for cat, weight in component_weight.items():
        c = (req_counts.get(cat) or {})
        total = int(c.get("total") or 0)
        matched_now = int(c.get("matched") or 0)
        delta = additions.get(("required", cat), 0)
        if total <= 0 or delta <= 0:
            continue
        new_matched = min(total, matched_now + delta)
        lift += ((new_matched - matched_now) / total) * weight

    # Preferred bucket — pooled across categories, single weight.
    pref_counts = (counts.get("preferred") or {})
    pref_total = sum(int((pref_counts.get(c) or {}).get("total") or 0) for c in _CATEGORIES)
    pref_matched_now = sum(int((pref_counts.get(c) or {}).get("matched") or 0) for c in _CATEGORIES)
    pref_delta = sum(additions.get(("preferred", c), 0) for c in _CATEGORIES)
    if pref_total > 0 and pref_delta > 0:
        new_matched = min(pref_total, pref_matched_now + pref_delta)
        lift += ((new_matched - pref_matched_now) / pref_total) * _KEYWORD_WEIGHTS["preferred_overall"]

    return lift


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _has_any_missing(missing_block: Dict[str, Any]) -> bool:
    if not isinstance(missing_block, dict):
        return False
    for bucket in _BUCKETS:
        cat_map = missing_block.get(bucket) or {}
        if not isinstance(cat_map, dict):
            continue
        for cat in _CATEGORIES:
            if cat_map.get(cat):
                return True
    return False


def _empty_plan() -> Dict[str, Any]:
    return {
        "feasibility_plan": {b: [] for b in _FEASIBILITY_BUCKETS},
        "summary": {
            "n_inject_directly":       0,
            "n_inject_as_extension":   0,
            "n_inject_with_inference": 0,
            "n_cannot_inject":         0,
            "expected_lift_pts":       0.0,
            "honest_gaps":             [],
        },
    }
