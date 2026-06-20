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
import re
from typing import Any, Dict, List, Tuple

from app.services.ai.client import AIClient
from app.services.ai.prompts import (
    KEYWORD_FEASIBILITY_SYSTEM,
    KEYWORD_FEASIBILITY_USER_TEMPLATE,
)
from app.services.skills.classifier import is_noise as _lex_is_noise

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

# JD-phrasing requirement fragments that are NOT clean, injectable keywords.
# The matcher sometimes extracts a whole requirement clause as a "keyword"
# ("working knowledge of WHS", "understanding of infection control"). These can
# never be surfaced verbatim as a skill — the real skill is the noun at the end
# ("WHS", "infection control") — so they only ever land on the "Approved but
# missed" list. We drop them from the feasibility plan entirely (neither
# injectable nor honest gap): they are noise, not a plannable gap.
#
# Conservative by design: each alternative REQUIRES the connective ("knowledge
# of", "experience in", "ability to") so genuine compound skills survive —
# "product knowledge", "knowledge management", "stakeholder management" have no
# "... of/in/to ..." and are untouched.
_FILLER_KEYWORD_RE = re.compile(
    r"^(?:"
    r"(?:working|sound|thorough|good|basic|strong|broad|in[- ]depth|practical|general|excellent)\s+)?"
    r"knowledge\s+of\b"
    r"|^(?:an?\s+)?understanding\s+of\b"
    r"|^ability\s+to\b"
    r"|^experience\s+(?:in|with|of|as|working|across|supporting)\b"
    r"|^previous\s+experience\b"
    r"|^familiarity\s+with\b"
    r"|^(?:willingness|commitment|passion|aptitude|interest|dedication)\s+(?:to|for|in)\b"
    r"|^(?:demonstrated|proven)\s+(?:ability|understanding|knowledge|experience)\b"
    # Qualification / credential phrases — always dropped from the feasibility plan.
    r"|^(?:certificate|cert\.?|diploma|advanced\s+diploma|bachelor|graduate|master)\s+"
    r"(?:i{1,4}|iv|[1-4]|of|in)\b"
    r"|^enrolled\s+in\b"
    r"|^completion\s+of\b"
    r"|^(?:rn|en|nursing)\s+student\b"
    r"|^overseas\s+(?:nursing|qualified)\b"
    r"|^(?:allied\s+health\s+student|assistant\s+in\s+nursing\s+qualification"
    r"|enrolled\s+nurse\s+qualification|registered\s+nurse\s+qualification)\b",
    re.IGNORECASE,
)


def _is_filler_keyword(kw: str) -> bool:
    """True if `kw` is a JD-phrasing requirement fragment, not a real keyword."""
    return bool(_FILLER_KEYWORD_RE.search((kw or "").strip().lower()))

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
    contact_details: Dict[str, Any] | None = None,
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
    plan = _reconcile_with_missing(
        plan, missing_block, matching=matching, contact_details=contact_details
    )
    # Soft-skill inference rules — the LLM classifier judges each keyword in
    # isolation and misses obvious inferences (empathy ← dementia care;
    # compliance mindset ← legal/ethical standards). This deterministic pass
    # walks cannot_inject and re-classifies any soft skill where the source
    # CV contains an evidence phrase from the curated rule table. Removes
    # run-to-run LLM inconsistency on these baseline soft skills.
    plan = _apply_soft_skill_inference_rules(plan, cv_text)

    # Deterministic honesty gate — for `inject_directly` entries (which the
    # downstream writer treats as "Strong CV evidence — added verbatim"),
    # require that the keyword's content tokens actually appear in the
    # supplied CV evidence quote. The LLM frequently cites a related-skill
    # quote and rationalises a cross-skill inference (e.g. evidence
    # "dressing, bathing, feeding" → claim "continence care"), which is
    # NOT verbatim grounding. Downgrade those to `inject_with_inference`
    # so they surface as "Inferred from adjacent evidence" in the UI.
    plan = _enforce_inject_directly_groundedness(plan, cv_text)

    # Counts and expected-lift summary — use the per-family weights so the
    # lift estimate matches what ats_scoring will award. Falls back to the
    # tech-shaped defaults if no role family is attached.
    counts = (matching or {}).get("counts") or {}
    weights = _resolve_keyword_weights(jd_analysis)
    expected_lift = _expected_lift_pts(plan, counts, weights)

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


def user_has_credential(kw: str, contact_details: Dict[str, Any] | None) -> bool:
    if not contact_details:
        return False
    creds = contact_details.get("credentials") or {}
    if not isinstance(creds, dict) or not creds:
        return False

    import re
    kw = kw.lower().strip()

    def has(key: str) -> bool:
        val = creds.get(key)
        if isinstance(val, str):
            return bool(val.strip())
        return bool(val)

    # 1. Car insurance
    if "insurance" in kw and ("car" in kw or "vehicle" in kw or "motor" in kw or "auto" in kw):
        return has("car_insurance")

    # 2. Compound Licence + Car (e.g. "driving and access to reliable car")
    # Use word-boundary match for 'car' to avoid matching 'care', 'cardiac', etc.
    is_licence_kw = "driver" in kw or "driving" in kw or "licence" in kw or "license" in kw
    is_car_kw = bool(re.search(r"\bcar\b", kw)) or "vehicle" in kw or "transport" in kw or "automobile" in kw
    if is_licence_kw and is_car_kw:
        return has("drivers_licence") and has("own_car")

    # 3. Forklift
    if "forklift" in kw:
        return has("forklift_licence")

    # 4. Driver's licence
    if "driver" in kw or "driving" in kw or "licence" in kw or "license" in kw:
        return has("drivers_licence")

    # 5. Own car — word-boundary match prevents 'wound care' / 'continence care'
    #    from triggering via the 'car' substring inside 'care'.
    if bool(re.search(r"\bcar\b", kw)) or "vehicle" in kw or "transport" in kw or "automobile" in kw:
        return has("own_car")

    # 6. Police check
    if "police" in kw or "npc" in kw or "criminal" in kw or "background check" in kw or "national police check" in kw:
        return has("police_check")

    # 7. First aid
    if "first aid" in kw or "hltaid011" in kw or "first-aid" in kw:
        return has("first_aid")

    # 8. CPR
    if "cpr" in kw or "hltaid009" in kw or "cardiopulmonary" in kw:
        return has("cpr")

    # 9. Medication
    if "medication" in kw or "med competency" in kw or "administer" in kw:
        return has("medication_competency")

    # 10. WWCC
    if "wwcc" in kw or "working with children" in kw or "child check" in kw or "blue card" in kw:
        return has("wwcc")

    # 11. NDIS
    if "ndis" in kw or "disability screening" in kw or "yellow card" in kw:
        return has("ndis_screening")

    # 12. White card
    if "white card" in kw:
        return has("white_card")

    # 13. Flu
    if "flu" in kw or "influenza" in kw:
        return has("flu_vaccination")

    # 14. Covid
    if "covid" in kw or "corona" in kw or "sars-cov" in kw or "covid-19" in kw:
        return has("covid_vaccination")

    # 15. General vaccination
    if "vaccination" in kw or "immunisation" in kw or "immunization" in kw:
        return has("covid_vaccination") or has("flu_vaccination")

    # 16. Work rights
    if "work rights" in kw or "visa" in kw or "citizenship" in kw or "right to work" in kw or "australian citizen" in kw:
        return has("work_rights")

    # 17. AHPRA / nursing registration — satisfied by a saved AHPRA number.
    #     Covers "AHPRA registration", "registered nurse", "current registration",
    #     "NMW..." style references. Guarded so generic "registration" inside an
    #     unrelated phrase still requires an ahpra cue.
    if (
        "ahpra" in kw
        or "nmw" in kw
        or "registered nurse" in kw
        or "enrolled nurse" in kw
        or "nursing registration" in kw
        or "nmba" in kw
        or ("registration" in kw and ("nurse" in kw or "nursing" in kw or "midwife" in kw or "ahpra" in kw))
    ):
        return has("ahpra_number")

    return False


def _reconcile_with_missing(
    plan: Dict[str, List[Dict[str, Any]]],
    missing_block: Dict[str, Dict[str, List[str]]],
    *,
    matching: Dict[str, Any],
    contact_details: Dict[str, Any] | None = None,
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
                if not k:
                    continue
                # JD-phrasing fragments ("working knowledge of WHS") are noise,
                # not a plannable gap — exclude from the feasibility plan
                # entirely so they never surface as "Approved but missed".
                if _is_filler_keyword(k):
                    continue
                # Safety net for old cached runs: if the phrase resolves to
                # universal noise (credential / eligibility / framework noise)
                # in the current lexicon, skip it here too.  New runs have these
                # already stripped by post_process_jd_analysis; this catches
                # runs where lexicon_meta was computed before the new entries
                # were added.
                if _lex_is_noise(k) is not None:
                    continue
                expected[k] = (bucket, cat)

    seen: set[str] = set()
    cleaned: Dict[str, List[Dict[str, Any]]] = {b: [] for b in _FEASIBILITY_BUCKETS}

    # 1. Force any missing keywords that are backed by user credentials into inject_directly
    for kw, (bucket, cat) in expected.items():
        if user_has_credential(kw, contact_details):
            cleaned["inject_directly"].append({
                "keyword": kw,
                "category": cat,
                "bucket":   bucket,
                "injection_target": "skills_section",
                "evidence": "Stamps from user profile credentials settings.",
                "rationale": "User has this credential enabled in their profile settings.",
            })
            seen.add(kw)

    # 2. Process AI plan entries
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


def _resolve_keyword_weights(jd_analysis: Dict[str, Any]) -> Dict[str, int]:
    """Pick per-family keyword weights (mirrors ats_scoring._resolve_keyword_weights).
    Falls back to the tech defaults when no role family is attached."""
    family_id = (jd_analysis or {}).get("role_family")
    if family_id:
        try:
            from app.services.eval.role_families import resolve_role_family
            rf = resolve_role_family(family_id, jd_analysis)
            if rf and rf.keyword_weights:
                return dict(rf.keyword_weights)
        except Exception:  # noqa: BLE001
            logger.warning("feasibility: failed to resolve family %s weights; using defaults", family_id)
    return dict(_KEYWORD_WEIGHTS)


def _expected_lift_pts(
    plan: Dict[str, List[Dict[str, Any]]],
    counts: Dict[str, Any],
    weights: Dict[str, int],
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
        "technical":        weights["technical_required"],
        "soft_skills":      weights["soft_skills_required"],
        "domain_knowledge": weights["domain_knowledge_required"],
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
        lift += ((new_matched - pref_matched_now) / pref_total) * weights["preferred_overall"]

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


# ---------------------------------------------------------------------------
# Deterministic groundedness gate — inject_directly must be VERBATIM
# ---------------------------------------------------------------------------
#
# The keyword_feasibility LLM is asked to classify each missed keyword into:
#
#   • inject_directly       — "Strong CV evidence — added verbatim"
#   • inject_as_extension   — "Reframed from existing achievements (reword)"
#   • inject_with_inference — "Inferred from adjacent evidence (defensible)"
#   • cannot_inject         — "Honest gap (no CV evidence)"
#
# In practice the LLM routinely puts cross-skill inferences in
# `inject_directly` (citing a CV quote that supports a DIFFERENT but related
# skill). Examples observed in production runs:
#
#   • evidence "dressing, bathing, feeding"        → claim "continence care"
#   • evidence "Time Management & Prioritization"  → claim "organisation"
#   • evidence "Infection Control & Workplace Safety" → claim "risk management"
#   • evidence "Collaborated with Registered Nurses…" → claim "verbal communication"
#
# The writer treats `inject_directly` as load-bearing — it goes straight
# into the Skills section with a literal-evidence label. Mis-bucketing
# costs honesty.
#
# Rule: an `inject_directly` entry must have an `evidence` quote that
# (a) appears in cv_text and (b) shares a >=4-char prefix-match content
# token with the keyword. Entries failing this test are DOWNGRADED to
# `inject_with_inference` — same content survives, but the UI now labels
# it "Inferred from adjacent evidence (defensible in interview)" instead
# of "Strong CV evidence — verbatim".

_VERBATIM_TOKEN_MIN_LEN = 4


def _content_tokens(text: str) -> List[str]:
    """Lowercase alpha-only tokens of length >= _VERBATIM_TOKEN_MIN_LEN."""
    return [
        t for t in re.findall(r"[a-z][a-z\-]+", text.lower())
        if len(t) >= _VERBATIM_TOKEN_MIN_LEN
    ]


def _evidence_grounds_keyword_verbatim(
    keyword: str, evidence: str, cv_text: str,
) -> bool:
    """True when:
      (1) ``evidence`` is non-empty and literally appears in ``cv_text``, AND
      (2) ``evidence`` contains at least one content token whose 4-char
          prefix is a prefix of a content token of ``keyword`` (or vice
          versa) — i.e. the evidence shares the keyword's word family.
    The 4-char prefix tolerates plural/inflection drift (continence ↔
    continent? — same family; manage ↔ management — same family) without
    accepting cross-family pairs (dressing ↔ continence — different).
    """
    if not keyword or not evidence:
        return False
    ev = evidence.strip()
    if not ev:
        return False
    # (1) literal CV presence — normalise whitespace + punctuation for the
    # check, but not so aggressively that we accept anything.
    cv_norm = re.sub(r"\s+", " ", cv_text).lower()
    ev_norm = re.sub(r"\s+", " ", ev).lower()
    if ev_norm not in cv_norm:
        # Also accept fuzzy match: first 6 content tokens of evidence appear
        # in CV (tolerates trailing punctuation/quote drift).
        head = " ".join(ev_norm.split()[:6])
        if head not in cv_norm:
            return False
    # (2) word-family overlap between keyword and evidence
    kw_tokens = _content_tokens(keyword)
    ev_tokens = _content_tokens(evidence)
    if not kw_tokens or not ev_tokens:
        return False
    for kt in kw_tokens:
        for et in ev_tokens:
            short, long_ = (kt, et) if len(kt) <= len(et) else (et, kt)
            if long_.startswith(short[:_VERBATIM_TOKEN_MIN_LEN]):
                return True
    return False


def _enforce_inject_directly_groundedness(
    plan: Dict[str, List[Dict[str, Any]]], cv_text: str,
) -> Dict[str, List[Dict[str, Any]]]:
    """Drop `inject_directly` entries whose evidence doesn't literally
    contain the keyword's word family (M4 — Phase F).

    Previously these were downgraded to inject_with_inference, which
    silently softened the honesty contract ("must be verbatim → may be
    inferred"). Now ungrounded entries are dropped entirely, consistent
    with the prompt's HARD "no fabrication" rule.
    Mutates a shallow copy. Idempotent.
    """
    if not plan or not cv_text:
        return plan
    direct = list(plan.get("inject_directly") or [])
    if not direct:
        return plan
    kept_direct: List[Dict[str, Any]] = []
    dropped: List[str] = []
    for entry in direct:
        if not isinstance(entry, dict):
            continue
        kw = entry.get("keyword") or ""
        ev = entry.get("evidence") or ""
        if _evidence_grounds_keyword_verbatim(kw, ev, cv_text):
            kept_direct.append(entry)
        else:
            dropped.append(kw)
    if not dropped:
        return plan
    out = dict(plan)
    out["inject_directly"] = kept_direct
    logger.info(
        "feasibility groundedness gate: dropped %d inject_directly "
        "(evidence quote did not contain keyword): %s",
        len(dropped), dropped,
    )
    return out


# ---------------------------------------------------------------------------
# Soft-skill inference rules
# ---------------------------------------------------------------------------
#
# The LLM classifier judges each soft-skill keyword in isolation and
# routinely misses inferences that are obvious to a recruiter:
#   • "empathy" — anyone who does dementia/palliative/mental-health care
#     practises empathy daily; refusing to claim it is over-honest.
#   • "compliance mindset" — "follow legal and ethical standards" + "follow
#     care protocols" is what compliance IS.
#   • "tolerance" — dementia care + mental-health support involves
#     challenging behaviours that require tolerance.
#   • "sense of belonging" — social engagement work fosters belonging.
# Worse: the LLM is RUN-TO-RUN INCONSISTENT — empathy injected one run,
# honest-gapped the next, same CV.
#
# This deterministic rule table runs AFTER the LLM classifier. For any
# keyword in cannot_inject that matches a rule AND has evidence in source,
# demote to inject_as_extension with a reason. Removes the inconsistency,
# closes the over-honesty gap, surfaces a transparent evidence chain.
#
# Conservative by design: only baseline soft skills + obvious mappings.
# Anything ambiguous stays an honest gap.

_SOFT_SKILL_INFERENCE_RULES: Dict[str, List[str]] = {
    "empathy": [
        "dementia", "palliative", "mental health", "elderly residents",
        "emotional", "compassion", "personal care", "supported residents",
    ],
    "compliance mindset": [
        "legal and ethical", "protocols", "policies", "procedures",
        "standards", "compliance",
    ],
    "tolerance": [
        "dementia", "mental health", "challenging", "diverse",
        "cultural",
    ],
    "sense of belonging": [
        "social engagement", "community", "belonging", "relationships",
        "social activities", "social interaction",
    ],
    "organisation": [
        "scheduled", "documentation", "records", "coordinated",
        "timely", "organised",
    ],
    "relationship building": [
        "social engagement", "relationships", "rapport", "collaborated",
        "trust", "communicated",
    ],
    "dedication": [
        "committed", "motivated", "dedicated", "punctual", "reliable",
    ],
    "desire for continuous learning": [
        "pursuing", "studying", "currently studying", "certificate",
        "master", "bachelor", "training",
    ],
    "patience": [
        "dementia", "palliative", "elderly", "supported", "calm",
    ],
    "active listening": [
        "listened", "communicated", "engaged", "supported residents",
    ],
    "attention to detail": [
        "accurate", "documentation", "records", "detailed", "precise",
    ],
    "problem-solving": [
        "resolved", "analysed", "troubleshoot", "solved", "addressed",
    ],
    "emotional resilience": [
        "dementia", "palliative", "challenging", "resilient", "calm",
    ],
    "customer service": [
        "customer", "client", "stakeholder", "professional",
    ],
    "leadership": [
        "led", "supervised", "coordinated", "mentored", "managed",
    ],
    "teamwork": [
        "team", "collaborated", "multidisciplinary",
    ],
    "collaboration": [
        "collaborated", "team", "multidisciplinary",
    ],
    "adaptability": [
        "adapted", "flexible", "various", "diverse",
    ],
}


def _apply_soft_skill_inference_rules(
    plan: Dict[str, List[Dict[str, Any]]], cv_text: str
) -> Dict[str, List[Dict[str, Any]]]:
    """Promote cannot_inject entries to inject_as_extension when a rule
    matches and source CV contains the evidence.

    Returns the modified plan dict (in place — caller may rebind).
    """
    if not plan.get("cannot_inject"):
        return plan
    cv_lower = (cv_text or "").lower()
    promoted: List[Dict[str, Any]] = []
    remaining: List[Dict[str, Any]] = []
    for entry in plan["cannot_inject"]:
        if not isinstance(entry, dict):
            remaining.append(entry)
            continue
        kw = str(entry.get("keyword") or "").strip().lower()
        evidence_terms = _SOFT_SKILL_INFERENCE_RULES.get(kw)
        if not evidence_terms:
            remaining.append(entry)
            continue
        hit = next((t for t in evidence_terms if t in cv_lower), None)
        if not hit:
            remaining.append(entry)
            continue
        # Match — promote to inject_as_extension with reason.
        promoted_entry = dict(entry)
        promoted_entry["evidence"] = f"Source CV contains '{hit}'"
        promoted_entry["reason"] = (
            f"Promoted by inference rule: '{kw}' is implied by source-CV "
            f"evidence '{hit}'. Baseline soft skill — claimable when source "
            f"shows the underlying activity."
        )
        # Keep category if present; otherwise default to soft skill.
        if not promoted_entry.get("category"):
            promoted_entry["category"] = "soft_skills"
        if not promoted_entry.get("bucket"):
            promoted_entry["bucket"] = entry.get("bucket") or "required"
        if not promoted_entry.get("suggested_rewrite"):
            # Generic skills-line append — the writer + force-inject pass will
            # decide where to land it.
            promoted_entry["suggested_rewrite"] = (
                f"Soft Skills: ... {kw.title()}"
            )
        promoted.append(promoted_entry)

    if promoted:
        plan["cannot_inject"] = remaining
        plan["inject_as_extension"] = list(plan.get("inject_as_extension") or []) + promoted
        logger.info(
            "soft-skill inference rules: promoted %d honest gap(s) to inject_as_extension: %s",
            len(promoted), [p.get("keyword") for p in promoted],
        )
    return plan
