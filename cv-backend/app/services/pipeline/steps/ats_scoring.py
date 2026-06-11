"""
Step 3 — ATS scoring.

Deterministic, no AI call. Reads the structured counts that the CV-JD
matching step now produces and turns them into a transparent 100-point
score the user can reproduce by hand.

100-point breakdown:

    Category 1 — Keyword Match (50 pts, derived from match_rates)
        technical_required        25 pts   ← weighted on the required bucket only
        soft_skills_required      10 pts
        domain_knowledge_required  5 pts
        preferred_overall         10 pts   ← all categories of the preferred bucket

    Category 2 — Experience Signal (35 pts)
        AI's raw_match_score scaled to 35 pts

    Category 3 — Formatting / Structure (15 pts)
        contact info + expected section headings + length sanity

The "overall_score" is the sum (0-100). Every component is exposed in the
breakdown so the UI can show exactly where points were earned and lost.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict

logger = logging.getLogger(__name__)

# Section headings we expect a well-structured CV to contain. Match as a
# heading word at the START of a line (optionally with a '#'/'**'/'-' prefix)
# followed by a word boundary. The previous version required end-of-line ($)
# which broke on PDF-extracted CVs where the heading word gets glued to the
# next bit of content on the same line — observed in real production runs
# (Rashmi's CV scored 1-of-3 sections instead of 3-of-3 → 60% formatting
# instead of 100%).  The old "literal word anywhere" check awarded points
# to any sentence containing the word, which we still don't want. This
# loosened version requires line-start anchoring but accepts trailing
# content, which is the right balance for real-world CV layouts.
_EXPECTED_SECTIONS = ("experience", "education", "skills")

# Per-section heading patterns. Each pattern matches at line-start (optionally
# with markdown/bold/bullet prefix) followed by a word boundary, so the
# heading word can stand alone OR have trailing content on the same line.
# Broadened by section to accept the real-world headings seen in production
# CVs after Rashmi's Run 2 only scored 2 of 3 sections — likely 'Skills' was
# named "Key Skills" / "Core Skills" / similar.
_SECTION_PATTERNS = {
    "experience": (
        r"experience|work\s+experience|professional\s+experience|"
        r"employment(?:\s+history)?|work\s+history|career\s+(?:history|summary)|"
        r"experience\s+summary"
    ),
    "education": (
        r"education|education\s+(?:summary|history|background)|"
        r"educational\s+(?:background|qualifications|history)|"
        r"academic\s+(?:background|qualifications|history)|qualifications"
    ),
    "skills": (
        r"skills|key\s+skills|core\s+skills|technical\s+skills|"
        r"soft\s+skills|professional\s+skills|hard\s+skills|"
        r"care\s+skills|clinical\s+skills|skills\s+(?:summary|section|profile)|"
        r"competencies|key\s+competencies|core\s+competencies|"
        r"areas\s+of\s+expertise|expertise"
    ),
}
_SECTION_HEADING_RES = {
    name: re.compile(
        r"(?im)^[\s\-\*#>]{0,6}"  # optional indent + markdown/bold/bullet prefix
        rf"(?:{pattern})"
        r"\b",  # word boundary — trailing content on the same line is OK
    )
    for name, pattern in _SECTION_PATTERNS.items()
}
# Contact-info patterns. Phone requires ≥10 digits total (AU is 10);
# the old 6-digit floor was matching dates/IDs/postcodes.
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_PHONE_RE = re.compile(r"\+?\d[\d\s\-().]{8,}\d")
_URL_RE = re.compile(r"https?://[^\s)]+")
_PHONE_DIGITS_RE = re.compile(r"\d")

# Per-component max points (must sum to 50 for Category 1).
_KEYWORD_WEIGHTS = {
    "technical_required":        25,
    "soft_skills_required":      10,
    "domain_knowledge_required":  5,
    "preferred_overall":         10,
}
_EXPERIENCE_MAX = 35
_FORMATTING_MAX = 15


def run_ats_scoring(
    cv_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
) -> Dict[str, Any]:
    # Per-family ATS weights: nursing/manual flip technical ↔ domain because
    # the headline competencies (Personal Care, Dementia Care, Forklift
    # Operation) live in domain_knowledge, not technical. Fallback to tech
    # defaults when no family is attached (legacy resumes / unknown vertical).
    weights = _resolve_keyword_weights(jd_analysis)

    keyword_total, keyword_breakdown = _keyword_score(matching, weights)
    experience = _experience_score(matching, jd_analysis)
    formatting = _formatting_score(cv_text)

    overall = int(round(keyword_total + experience + formatting))
    overall = max(0, min(100, overall))

    return {
        # Top-level numbers (each on a 0-100 scale where applicable, or
        # the raw point contribution where noted).
        "overall_score": overall,
        "keyword_match_score": _to_pct(keyword_total, sum(weights.values())),
        "experience_match_score": _to_pct(experience, _EXPERIENCE_MAX),
        "formatting_score": _to_pct(formatting, _FORMATTING_MAX),

        # Transparent point breakdown so the UI can render "you earned 18/25
        # on technical-required" etc.
        "breakdown": {
            "category_1_keyword_match": {
                "earned": round(keyword_total, 1),
                "max": sum(weights.values()),
                "components": keyword_breakdown,
            },
            "category_2_experience": {
                "earned": round(experience, 1),
                "max": _EXPERIENCE_MAX,
                "source": "deterministic: required-match-rate + matched-responsibilities + role-family-alignment",
            },
            "category_3_formatting": {
                "earned": round(formatting, 1),
                "max": _FORMATTING_MAX,
            },
            "weights": {
                "keyword_max": sum(weights.values()),
                "experience_max": _EXPERIENCE_MAX,
                "formatting_max": _FORMATTING_MAX,
                "per_bucket": weights,
            },
        },

        # Echo the matching step's per-category rates for downstream
        # convenience (UI, recommendation engine).
        "match_rates": matching.get("match_rates") or {},
        "counts": matching.get("counts") or {},
    }


# ---------------------------------------------------------------------------
# Category 1 — Keyword match (50 pts)
# ---------------------------------------------------------------------------


def _resolve_keyword_weights(jd_analysis: Dict[str, Any]) -> Dict[str, int]:
    """Pick the per-family keyword weights, falling back to tech defaults.

    The orchestrator stores the resolved role family on `jd_analysis["role_family"]`
    before ATS scoring (orchestrator.py:131-139). When the family ships with a
    `keyword_weights` dict (nursing/manual flip technical↔domain), use it;
    otherwise the tech-shaped defaults below apply — same behaviour as before.
    """
    family_id = (jd_analysis or {}).get("role_family")
    if family_id:
        try:
            from app.services.eval.role_families import resolve_role_family
            rf = resolve_role_family(family_id, jd_analysis)
            if rf and rf.keyword_weights:
                return dict(rf.keyword_weights)
        except Exception:  # noqa: BLE001 — never block scoring on a config lookup
            logger.warning("ATS: failed to resolve family %s weights; using defaults", family_id)
    return dict(_KEYWORD_WEIGHTS)


def _keyword_score(
    matching: Dict[str, Any], weights: Dict[str, int]
) -> tuple[float, Dict[str, Any]]:
    """
    Compute Category 1 directly from the structured counts produced by
    the matching step. No substring searching, no text parsing.

    Presence-aware: the nominal weights in ``_KEYWORD_WEIGHTS`` are shaped for
    IT roles (technical-required carries 25 of 50). A nursing or care JD often
    has zero required-technical keywords, which under a fixed-weight scheme
    would make 25 of the 50 keyword points permanently unreachable and cap a
    perfect-match CV at ~50 %. To keep the category fair across role families,
    the weight of any bucket the JD did not populate (total = 0) is
    redistributed proportionally onto the buckets it DID populate, so a CV that
    perfectly matches every requested keyword earns the full 50.

    Each present component then contributes (matched / total) * effective_weight.
    """
    counts = matching.get("counts") or {}
    required = counts.get("required") or {}
    preferred = counts.get("preferred") or {}

    tech = required.get("technical") or {"matched": 0, "total": 0}
    soft = required.get("soft_skills") or {"matched": 0, "total": 0}
    domain = required.get("domain_knowledge") or {"matched": 0, "total": 0}

    pref_matched = sum((preferred.get(c) or {}).get("matched", 0) for c in
                       ("technical", "soft_skills", "domain_knowledge"))
    pref_total = sum((preferred.get(c) or {}).get("total", 0) for c in
                     ("technical", "soft_skills", "domain_knowledge"))

    raw = {
        "technical_required":        (tech["matched"], tech["total"]),
        "soft_skills_required":      (soft["matched"], soft["total"]),
        "domain_knowledge_required": (domain["matched"], domain["total"]),
        "preferred_overall":         (pref_matched, pref_total),
    }

    # Redistribute the nominal weight of empty buckets onto populated ones.
    present_base = sum(weights[k] for k, (_, total) in raw.items() if total > 0)
    scale = (sum(weights.values()) / present_base) if present_base else 0.0

    components: Dict[str, Any] = {}
    for key, (matched, total) in raw.items():
        base = weights[key]
        effective = base * scale if total > 0 else 0.0
        rate = (matched / total) if total else 0.0
        components[key] = {
            "matched": matched,
            "total": total,
            "match_rate_pct": round(rate * 100, 1),
            "base_points": base,
            "max_points": round(effective, 2),
            "earned_points": round(rate * effective, 2),
        }

    total = sum(c["earned_points"] for c in components.values())
    return total, components


# ---------------------------------------------------------------------------
# Category 2 — Experience (35 pts)
# ---------------------------------------------------------------------------


def _experience_score(
    matching: Dict[str, Any], jd_analysis: Dict[str, Any] | None = None
) -> float:
    """Deterministic experience score (35 pts max).

    The previous version scaled the AI's ``raw_match_score`` (a single integer
    the model emits at temperature 0.1) directly. That number swings ±10-15
    points across identical runs and was the single biggest driver of the
    documented 86→57→69 ATS variance.

    Replaced with three deterministic sub-signals — all derived from data
    earlier pipeline steps already produced. ``raw_match_score`` is kept in
    the matching payload for logging but no longer affects the score.

    Sub-signals (35 pts total):

      Required-keyword match rate (15 pts)
        ≥ 80% → 15, 60-79% → 10, 40-59% → 6, < 40% → 0.

      Matched responsibilities (12 pts)
        Count of JD responsibilities the matcher said the CV satisfies, vs
        the total. ≥ 75% covered → 12, ≥ 50% → 8, ≥ 25% → 4, > 0 → 2, else 0.

      Role-family alignment (8 pts)
        If the resolved role_family is one of the production families
        (nursing / tech / manual) — i.e. the JD title was recognised — the
        candidate's CV is being scored against the right rubric. 8 pts.
        ``master`` (the fallback) means the family wasn't recognisable from
        the JD title → 4 pts (still scoring, but with less confidence).
    """
    pts = 0.0

    # 1. Required-keyword match rate (15 pts)
    counts = matching.get("counts") or {}
    req = counts.get("required") or {}
    req_matched = sum((req.get(c) or {}).get("matched", 0) for c in
                      ("technical", "soft_skills", "domain_knowledge"))
    req_total = sum((req.get(c) or {}).get("total", 0) for c in
                    ("technical", "soft_skills", "domain_knowledge"))
    if req_total > 0:
        rate = req_matched / req_total
        if rate >= 0.80:
            pts += 15
        elif rate >= 0.60:
            pts += 10
        elif rate >= 0.40:
            pts += 6
    else:
        # JD has no required keywords at all — neutral, give half.
        pts += 7.5

    # 2. Matched responsibilities (12 pts)
    matched_resp = matching.get("matched_responsibilities") or []
    total_resp = []
    if jd_analysis:
        total_resp = jd_analysis.get("responsibilities") or []
    if total_resp:
        cov = len(matched_resp) / len(total_resp)
        if cov >= 0.75:
            pts += 12
        elif cov >= 0.50:
            pts += 8
        elif cov >= 0.25:
            pts += 4
        elif cov > 0:
            pts += 2
    else:
        # No JD responsibilities listed — neutral half.
        pts += 6

    # 3. Role-family alignment (8 pts)
    fam = (jd_analysis or {}).get("role_family")
    if fam in ("nursing", "tech", "manual"):
        pts += 8
    elif fam == "master":
        pts += 4
    # Unknown / missing → 0.

    return min(pts, _EXPERIENCE_MAX)


# ---------------------------------------------------------------------------
# Category 3 — Formatting (15 pts)
# ---------------------------------------------------------------------------


def _formatting_score(cv_text: str) -> float:
    """Structural checks: contact info present, expected sections present, length sane.

    Section headings are matched as actual headings (line-start, optionally
    '#'-prefixed), not as bare words anywhere — the old check awarded full
    section points to any CV with the word "experience" anywhere.

    Length window broadened (150-2500 full marks, 100-3000 half) because
    nursing CVs with credential lists routinely exceed the old 1500 ceiling.

    Phone match requires ≥10 digits so dates / postcodes / IDs don't count.
    """
    if not cv_text:
        return 0.0

    raw = 0  # accumulator on a 100-point internal scale, then rescaled to 15

    # Contact info — up to 30
    if _EMAIL_RE.search(cv_text):
        raw += 15
    phone_hit = False
    for m in _PHONE_RE.finditer(cv_text):
        if len(_PHONE_DIGITS_RE.findall(m.group(0))) >= 10:
            phone_hit = True
            break
    if phone_hit or _URL_RE.search(cv_text):
        raw += 15

    # Expected sections — up to 60 (20 each). Must appear as a heading line,
    # not as the literal word anywhere in the text.
    for name, pattern in _SECTION_HEADING_RES.items():
        if pattern.search(cv_text):
            raw += 20

    # Length sanity — up to 10. Nursing CVs with credential lists routinely
    # exceed the old 1500 ceiling; broaden to 150-2500 for full marks.
    word_count = len(cv_text.split())
    if 150 <= word_count <= 2500:
        raw += 10
    elif 100 <= word_count < 150 or 2500 < word_count <= 3000:
        raw += 5

    raw = min(raw, 100)
    return (raw / 100.0) * _FORMATTING_MAX


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_pct(earned: float, maximum: int) -> int:
    """Convert an earned-points value back to a 0-100 number for legacy fields."""
    if maximum <= 0:
        return 0
    return int(round((earned / maximum) * 100))
