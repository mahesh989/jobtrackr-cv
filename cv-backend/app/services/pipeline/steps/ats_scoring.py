"""
Step 3 — ATS scoring (v2).

Deterministic, no AI call. Reads:
  • the structured counts the CV↔JD matching step produced,
  • the JD's structured analysis (responsibilities, experience_years_required,
    role_family),
  • the raw CV text,
and turns them into a transparent 100-point score the user can reproduce by
hand.

100-point breakdown:

    Category 1 — Keyword Match (50 pts, derived from match_rates)
        Per role family (tech default vs nursing/manual flip):
            technical_required        25 pts (5 on nursing/manual)
            soft_skills_required      10 pts
            domain_knowledge_required  5 pts (25 on nursing/manual)
            preferred_overall         10 pts
        Presence-aware: empty buckets' weight is redistributed onto populated
        ones so a perfect match always reaches 50 regardless of JD shape.

    Category 2 — Experience (40 pts) — v2: rewritten from scratch
        Responsibility coverage   (20 pts) — verifiable JD-duty ↔ CV-bullet match
        Relevant tenure           (12 pts) — CV months in the JD's vertical vs
                                              experience_years_required
        Vertical alignment        ( 8 pts) — % of CV experience entries whose
                                              primary vertical equals the JD's
        Old defects intentionally removed:
          - Required-keyword-match rate sub-signal: was Category-1 counted
            again. Removed; keyword coverage is scored ONCE in Cat 1.
          - Role-family "freebie" (8 pts for JD being recognised): rewarded
            JD-side classification, not CV↔JD fit. Replaced by CV-side
            vertical alignment which is CV-earned.
          - AI raw_match_score: kept on the matching payload for logs but
            no longer reaches the scorer.

    Category 3 — Formatting / Structure (10 pts)
        contact (3) + expected section headings (6) + length sanity (1).
        Hygiene check, not a discriminator — most real CVs score 9-10/10.

The "overall_score" is the sum (0-100). Every component is exposed in the
breakdown so the UI can show exactly where points were earned and lost.

Critical invariant: tailoring (keyword injection) moves Category 1 only.
Categories 2 and 3 read different parts of the document (experience
narrative + formatting), neither of which the writer can fabricate from
the feasibility plan — so predicted lift equals actual lift.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.cv.experience_parser import (
    parse_cv_experience,
    relevant_tenure_months,
    vertical_alignment_ratio,
)

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
# v2: 50 / 40 / 10
_EXPERIENCE_MAX = 40
_FORMATTING_MAX = 10

# Category 2 sub-signal budgets (must sum to _EXPERIENCE_MAX).
_EXP_RESPONSIBILITY_MAX = 20
_EXP_TENURE_MAX         = 12
_EXP_VERTICAL_MAX       =  8

# Role-family → CV-side vertical (lexicon vertical used by experience_parser).
# Mirrors ats_scoring's _ROLE_FAMILY_TO_VERTICAL on the skills side.
_ROLE_FAMILY_TO_CV_VERTICAL: Dict[str, Optional[str]] = {
    "tech":    "tech",
    "nursing": "nursing",
    "manual":  "cleaning",
    "master":  None,
}


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
    experience, experience_components = _experience_score(cv_text, matching, jd_analysis)
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
                "source": "v2 deterministic: responsibility-coverage + relevant-tenure + vertical-alignment",
                "components": experience_components,
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
    cv_text: str,
    matching: Dict[str, Any],
    jd_analysis: Optional[Dict[str, Any]] = None,
) -> Tuple[float, Dict[str, Any]]:
    """v2 deterministic experience score (40 pts max).

    Three sub-signals, each reading a different part of the CV's
    experience section — no overlap with Category 1's keyword counts,
    so tailoring keywords cannot move this number.

    Returns ``(earned_points, components)`` so the breakdown can show the
    user which sub-signal contributed what.

    Sub-signals
    ===========

    Responsibility coverage (20 pts)
      Fraction of the JD's ``responsibilities`` whose VERB-NOUN content
      appears verbatim somewhere in the CV's experience bullets.
      A linear scale: ``(covered / total) × 20``. When the JD lists no
      responsibilities → neutral half (10 pts), matching the old
      conservative behaviour.

    Relevant tenure (12 pts)
      Months of CV experience whose **primary vertical** equals the JD's
      role family (resolved via the lexicon classifier on each entry's
      bullets — same source of truth as JD analysis). Compared against
      ``jd_analysis.experience_years_required``:
        - Required years missing → tenure presence-only: 12 pts if any
          relevant tenure, else 0.
        - Required years stated → linear up to the requirement, capped at
          ``required_years × 12 / required_years`` = 12.
      Master family (JD title not classifiable) → neutral half (6 pts) —
      we cannot evaluate vertical-relative tenure when the vertical is
      unknown.

    Vertical alignment (8 pts)
      Fraction of CV experience entries whose primary vertical equals the
      JD's. ``(aligned / total_entries) × 8``. Replaces the old
      role-family freebie which awarded 8 pts based on JD-title
      classification alone. The CV must EARN this now.
    """
    components: Dict[str, Any] = {}
    pts = 0.0

    fam = (jd_analysis or {}).get("role_family")
    jd_vertical = _ROLE_FAMILY_TO_CV_VERTICAL.get(fam) if fam else None

    # Parse CV experience once and share with both tenure + alignment sub-signals.
    try:
        entries = parse_cv_experience(cv_text)
    except Exception:  # noqa: BLE001 — never block scoring on a parser hiccup
        logger.warning("ATS v2: CV experience parser failed; treating as empty")
        entries = []

    # ── 1. Responsibility coverage (20 pts) ──
    responsibilities: List[str] = []
    if jd_analysis:
        responsibilities = jd_analysis.get("responsibilities") or []
    covered, covered_list = _count_responsibilities_covered(responsibilities, cv_text)
    if responsibilities:
        rate = covered / len(responsibilities)
        resp_pts = rate * _EXP_RESPONSIBILITY_MAX
    else:
        resp_pts = _EXP_RESPONSIBILITY_MAX / 2.0
    pts += resp_pts
    components["responsibility_coverage"] = {
        "covered": covered,
        "total": len(responsibilities),
        "covered_list": covered_list,
        "max_points": _EXP_RESPONSIBILITY_MAX,
        "earned_points": round(resp_pts, 2),
    }

    # ── 2. Relevant tenure (12 pts) ──
    relevant_months = relevant_tenure_months(entries, jd_vertical)
    required_years_raw = (jd_analysis or {}).get("experience_years_required")
    required_years: Optional[float] = None
    if isinstance(required_years_raw, (int, float)) and required_years_raw > 0:
        required_years = float(required_years_raw)

    if jd_vertical is None:
        # Unknown JD family — can't evaluate vertical-relative tenure honestly.
        tenure_pts = _EXP_TENURE_MAX / 2.0
        tenure_basis = "neutral_unknown_family"
    elif required_years is not None:
        required_months = required_years * 12.0
        rate = min(1.0, relevant_months / required_months) if required_months else 0.0
        tenure_pts = rate * _EXP_TENURE_MAX
        tenure_basis = f"vs_required_{required_years}_yrs"
    else:
        # JD didn't state a year requirement — presence-only check.
        tenure_pts = float(_EXP_TENURE_MAX) if relevant_months > 0 else 0.0
        tenure_basis = "presence_only_no_requirement"
    pts += tenure_pts
    components["relevant_tenure"] = {
        "relevant_months": relevant_months,
        "required_years": required_years,
        "basis": tenure_basis,
        "max_points": _EXP_TENURE_MAX,
        "earned_points": round(tenure_pts, 2),
    }

    # ── 3. Vertical alignment (8 pts) ──
    if jd_vertical is None:
        alignment = 0.0
        alignment_basis = "unknown_family"
        align_pts = _EXP_VERTICAL_MAX / 2.0  # neutral half — same reason as tenure
    else:
        alignment = vertical_alignment_ratio(entries, jd_vertical)
        alignment_basis = f"primary_vertical_eq_{jd_vertical}"
        align_pts = alignment * _EXP_VERTICAL_MAX
    pts += align_pts
    components["vertical_alignment"] = {
        "jd_vertical": jd_vertical,
        "alignment_ratio": round(alignment, 3),
        "n_entries": len(entries),
        "basis": alignment_basis,
        "max_points": _EXP_VERTICAL_MAX,
        "earned_points": round(align_pts, 2),
    }

    earned = min(pts, float(_EXPERIENCE_MAX))
    return earned, components


# Light verb-noun overlap check between a JD responsibility and the CV's
# experience bullets. We don't need a parser here — strip stopwords / short
# tokens and require ≥2 of the responsibility's content tokens to appear
# anywhere in cv_text (case-insensitive). Conservative — a single keyword
# overlap isn't enough; two keeps the check from over-rewarding generic
# bullets like "support residents".
_RESP_STOPWORDS = frozenset({
    "and", "or", "the", "a", "an", "to", "in", "on", "of", "for", "with",
    "as", "by", "at", "from", "into", "via", "per", "any", "all", "ensure",
    "ensuring", "support", "provide", "providing", "work", "working",
    "contribute", "participate", "deliver", "delivering", "assist",
    "assisting", "help", "helping", "carry", "carrying", "out",
})


def _count_responsibilities_covered(
    responsibilities: List[str], cv_text: str,
) -> Tuple[int, List[str]]:
    """Return (covered_count, covered_responsibility_strings).

    A responsibility is "covered" when ≥2 of its content tokens (length ≥ 4,
    not in ``_RESP_STOPWORDS``) appear in ``cv_text``. Word-boundary
    case-insensitive. Returns the list of covered strings for audit.
    """
    if not responsibilities or not cv_text:
        return 0, []
    cv_lower = cv_text.lower()
    covered: List[str] = []
    for resp in responsibilities:
        if not isinstance(resp, str):
            continue
        text = resp.strip()
        if not text:
            continue
        tokens = [
            t for t in re.findall(r"[a-z][a-z\-]+", text.lower())
            if len(t) >= 4 and t not in _RESP_STOPWORDS
        ]
        if not tokens:
            continue
        hits = sum(
            1 for t in tokens
            if re.search(r"\b" + re.escape(t) + r"\b", cv_lower)
        )
        if hits >= 2:
            covered.append(text)
    return len(covered), covered


# ---------------------------------------------------------------------------
# Category 3 — Formatting (15 pts)
# ---------------------------------------------------------------------------


def _formatting_score(cv_text: str) -> float:
    """v2 formatting score (10 pts max — hygiene check, not a discriminator).

    Three sub-checks, designed so most real CVs score 9-10/10:
      Contact (3): email + (phone OR URL)
      Sections (6): experience / education / skills headings present
      Length (1): word count in a sane range

    Sub-totals are returned on the final 10-pt scale directly (no internal
    100-pt rescale) for transparency. The hard ceiling is exactly 10 so the
    tailored-side ``_floor_formatting`` rule keeps working unchanged.

    Section headings are matched as actual headings (line-start, optionally
    '#'-prefixed); phone requires ≥10 digits so dates/postcodes don't count.
    """
    if not cv_text:
        return 0.0

    pts = 0.0

    # Contact (3 pts) — email (1.5) + phone/URL (1.5)
    if _EMAIL_RE.search(cv_text):
        pts += 1.5
    phone_hit = False
    for m in _PHONE_RE.finditer(cv_text):
        if len(_PHONE_DIGITS_RE.findall(m.group(0))) >= 10:
            phone_hit = True
            break
    if phone_hit or _URL_RE.search(cv_text):
        pts += 1.5

    # Sections (6 pts) — 2 each for experience / education / skills headings.
    for _name, pattern in _SECTION_HEADING_RES.items():
        if pattern.search(cv_text):
            pts += 2.0

    # Length (1 pt) — full mark in a wide window, half outside it.
    word_count = len(cv_text.split())
    if 150 <= word_count <= 2500:
        pts += 1.0
    elif 100 <= word_count < 150 or 2500 < word_count <= 3000:
        pts += 0.5

    return min(pts, float(_FORMATTING_MAX))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_pct(earned: float, maximum: int) -> int:
    """Convert an earned-points value back to a 0-100 number for legacy fields."""
    if maximum <= 0:
        return 0
    return int(round((earned / maximum) * 100))
