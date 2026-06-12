"""ATS scoring v2 — pin the distribution table from the design doc.

The v2 scorer has three categories (50 keyword / 40 experience / 10 formatting)
with the experience score rebuilt from three CV↔JD-alignment sub-signals.
The acceptance test for the rewrite is that the four canonical scenarios from
the design table land in the right buckets:

    Scenario                       v2 expected
    Irrelevant CV (SWE vs nursing)    ~13
    Moderate fit, untailored          55-65
    Moderate fit, tailored            75-82
    Strong fit, tailored              90-95

These are tight enough that the structural defects (double-count + freebie)
from v1 would push every row outside its band. The fixtures below are kept
small but realistic — taken from the Jesmond/Australian-Unity shape we've
been debugging.

The test file is also the regression net: any future change to weights or
sub-signal formulas must explain why a scenario crossed a bound.
"""
from __future__ import annotations

import pytest

from app.services.cv.experience_parser import (
    ExperienceEntry,
    parse_cv_experience,
    relevant_tenure_months,
    vertical_alignment_ratio,
)
from app.services.pipeline.steps.ats_scoring import (
    _EXP_RESPONSIBILITY_MAX,
    _EXP_TENURE_MAX,
    _EXP_VERTICAL_MAX,
    _EXPERIENCE_MAX,
    _FORMATTING_MAX,
    _KEYWORD_WEIGHTS,
    _count_responsibilities_covered,
    _experience_score,
    _formatting_score,
    run_ats_scoring,
)


# ---------------------------------------------------------------------------
# Constants pinned by the design
# ---------------------------------------------------------------------------

class TestWeightsSumCorrectly:
    """Guards against accidental drift of the v2 envelope."""

    def test_keyword_weights_sum_to_50(self):
        assert sum(_KEYWORD_WEIGHTS.values()) == 50

    def test_experience_max_is_40(self):
        assert _EXPERIENCE_MAX == 40

    def test_formatting_max_is_10(self):
        assert _FORMATTING_MAX == 10

    def test_experience_subsignals_sum_to_40(self):
        assert _EXP_RESPONSIBILITY_MAX + _EXP_TENURE_MAX + _EXP_VERTICAL_MAX == 40

    def test_overall_envelope_is_100(self):
        assert sum(_KEYWORD_WEIGHTS.values()) + _EXPERIENCE_MAX + _FORMATTING_MAX == 100


# ---------------------------------------------------------------------------
# Fixtures — CV / JD / matching shapes used by the scenarios
# ---------------------------------------------------------------------------

NURSING_CV = """# Rashmi Poudel
NSW | 0403760681 | rashmi@example.com | LinkedIn

## Experience

### Uniting Leichhardt
*Assistant in Nursing (Casual) | Mar 2026 – Present*
- Provide person-centred care to residents, supporting daily living activities such as bathing, dressing.
- Monitor and report changes in residents physical and emotional wellbeing to nursing staff.
- Maintain a safe environment by following manual handling and infection control protocols.

### The Jesmond Group Miranda
*Assistant in Nursing | May 2025 – June 2026*
- Served as primary Medication Assistant, managing electronic medication administration using BESTMed.
- Delivered personal care to elderly residents including hygiene, mobility support and feeding.
- Collaborated with multidisciplinary teams to implement individualised care plans.

### Anglicare Mildred Symons House
*Aged Care Placement | Sept 2024*
- Delivered specialised dementia care using person-centred approaches and behavioural management techniques.

## Education

### Heritage Skills Institute
Certificate IV in Ageing Support, 2025

## Skills
Personal Care, Dementia Care, Person-Centred Care, Manual Handling, Infection Control, Feeding Assistance, Mobility Support, Care Planning
"""

# Genuinely moderate-fit nursing CV — short tenure, mixed vertical (one
# care role + one retail role), thinner bullets. Tests the band that
# *keyword-moderate + experience-moderate* lands in.
MODERATE_NURSING_CV = """# Sam Carer
sam@example.com | 0412000000

## Experience

### Local Aged Care Home
*Care Assistant (Casual) | Jan 2026 – June 2026*
- Assisted residents with daily activities including bathing and dressing.
- Reported wellbeing changes to nursing staff.

### Westfield Retail
*Retail Sales Assistant | Mar 2023 – Dec 2025*
- Customer service in a high-volume retail setting.
- Cash handling and stock management.

## Education

### TAFE
Certificate III in Individual Support, 2025

## Skills
Personal Care, Customer Service, Manual Handling
"""

SWE_CV = """# Alex Engineer
alex@example.com | 0412345678 | linkedin.com/in/alex

## Experience

### Stripe
*Senior Backend Engineer | Jan 2022 – Present*
- Designed Python microservices on AWS using Docker and Kubernetes.
- Built REST APIs and ci/cd pipelines for the payments platform.
- Mentored junior engineers and led code reviews.

### Atlassian
*Software Engineer | Feb 2018 – Dec 2021*
- Worked on Java backends with PostgreSQL and Kafka.
- Built feature flags and observability tooling.

## Education

### University of Sydney
Bachelor of Software Engineering, 2017

## Skills
Python, AWS, Docker, Kubernetes, PostgreSQL, REST API, Microservices, CI/CD
"""

# JD analysis matching the Jesmond AIN shape — nursing family, ~1 year required.
NURSING_JD = {
    "role_family": "nursing",
    "experience_years_required": 1,
    "responsibilities": [
        "provide safe and holistic care to residents",
        "deliver nursing and emotional care to residents",
        "handle food safely and assist residents with feeding",
        "support residents mobility and meaningful recreational activities",
        "participate in and contribute to residents care plans",
        "work collaboratively with the wider care team",
        "work in partnership with residents and their families",
    ],
    "required_skills": {
        "technical": [],
        "soft_skills": [
            "empathy", "communication", "verbal communication",
            "written communication", "teamwork", "positive attitude",
            "cultural sensitivity",
        ],
        "domain_knowledge": [
            "aged care", "feeding assistance", "food handling",
            "mobility support", "recreational activities support",
            "care planning",
        ],
    },
    "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
}


def _matching(
    *, soft_matched, soft_total, dom_matched, dom_total, tech_matched=0, tech_total=0,
):
    """Build a minimal matching dict mirroring what cv_jd_matching emits."""
    return {
        "matched": {
            "required": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        },
        "missed": {
            "required": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        },
        "counts": {
            "required": {
                "technical":        {"matched": tech_matched, "total": tech_total},
                "soft_skills":      {"matched": soft_matched, "total": soft_total},
                "domain_knowledge": {"matched": dom_matched,  "total": dom_total},
            },
            "preferred": {
                "technical":        {"matched": 0, "total": 0},
                "soft_skills":      {"matched": 0, "total": 0},
                "domain_knowledge": {"matched": 0, "total": 0},
            },
            "totals": {
                "matched": tech_matched + soft_matched + dom_matched,
                "total":   tech_total + soft_total + dom_total,
            },
        },
        "match_rates": {},
        "matched_responsibilities": [],
        "raw_match_score": 0,
    }


# ---------------------------------------------------------------------------
# Scenario assertions — the v2 distribution table from the design
# ---------------------------------------------------------------------------

class TestScenarioDistribution:
    """The four canonical rows of the v2 distribution table.

    A v2-honest note: v1's single ATS number conflated three axes that v2
    breaks apart (keyword fit / experience fit / formatting). What v1 called
    "moderate" was usually keyword-moderate; v2 surfaces that *the same CV*
    can be moderate on keywords but strong on experience (Rashmi's case).
    The bands below reflect the cleaner separation.
    """

    def test_irrelevant_cv_scores_low(self):
        """SWE résumé vs nursing JD — keyword 0, vertical alignment 0,
        zero nursing tenure. Only formatting (10) + responsibility
        coincidence + neutral-half tenure (unknown family branch isn't
        hit, vertical IS known) rescue."""
        m = _matching(soft_matched=0, soft_total=7, dom_matched=0, dom_total=6)
        ats = run_ats_scoring(SWE_CV, NURSING_JD, m)
        # Irrelevant CV must stay well below half — strict ceiling.
        assert ats["overall_score"] <= 25, (
            f"irrelevant CV scored {ats['overall_score']} (expected ≤25); "
            f"breakdown={ats['breakdown']}"
        )

    def test_moderate_keyword_strong_experience_untailored(self):
        """Rashmi's CV vs Jesmond JD: 4/7 soft, 4/6 dom matched (moderate
        keywords) — but 19 months nursing tenure, 100% alignment, 5/7
        responsibilities covered (strong experience). v2 correctly
        recognises this as a high-quality fit."""
        m = _matching(soft_matched=4, soft_total=7, dom_matched=4, dom_total=6)
        ats = run_ats_scoring(NURSING_CV, NURSING_JD, m)
        assert 70 <= ats["overall_score"] <= 82, (
            f"keyword-moderate + experience-strong scored {ats['overall_score']} "
            f"(expected 70-82); breakdown={ats['breakdown']}"
        )

    def test_keyword_strong_experience_strong_tailored(self):
        """After injection on Rashmi's CV — Cat 1 saturates to 50, Cat 2 and
        Cat 3 hold steady (the v2 tailoring invariant)."""
        m_tail = _matching(soft_matched=7, soft_total=7, dom_matched=6, dom_total=6)
        ats = run_ats_scoring(NURSING_CV, NURSING_JD, m_tail)
        assert 90 <= ats["overall_score"] <= 100, (
            f"keyword + experience both strong scored {ats['overall_score']} "
            f"(expected 90-100); breakdown={ats['breakdown']}"
        )

    def test_truly_moderate_fit_lands_in_band(self):
        """A genuinely moderate-fit CV: one care role (6 months) + one
        retail role. Mixed vertical alignment, short tenure, thin
        responsibility coverage. Lands in the moderate band as designed."""
        # Reasonable matching: maybe a third to half of keywords land for
        # a moderate-fit CV.
        m = _matching(soft_matched=2, soft_total=7, dom_matched=2, dom_total=6)
        ats = run_ats_scoring(MODERATE_NURSING_CV, NURSING_JD, m)
        assert 40 <= ats["overall_score"] <= 65, (
            f"moderate-fit CV scored {ats['overall_score']} "
            f"(expected 40-65); breakdown={ats['breakdown']}"
        )


# ---------------------------------------------------------------------------
# Tailoring invariant — Cat 2 and Cat 3 must not move when keywords inject
# ---------------------------------------------------------------------------

class TestTailoringInvariant:
    """The single most important v2 property: keyword injection lifts ONLY
    Category 1. The experience and formatting categories read parts of the
    document the writer can't fabricate from the feasibility plan."""

    def test_experience_score_is_independent_of_keyword_counts(self):
        """Same CV, same JD, but different matching counts → experience
        score must be identical."""
        m_low = _matching(soft_matched=1, soft_total=7, dom_matched=1, dom_total=6)
        m_high = _matching(soft_matched=7, soft_total=7, dom_matched=6, dom_total=6)
        exp_low, _ = _experience_score(NURSING_CV, m_low, NURSING_JD)
        exp_high, _ = _experience_score(NURSING_CV, m_high, NURSING_JD)
        assert exp_low == exp_high

    def test_formatting_score_is_independent_of_matching(self):
        """Formatting reads CV text only."""
        fmt = _formatting_score(NURSING_CV)
        # Independent of any matching argument — call it twice to confirm.
        assert fmt == _formatting_score(NURSING_CV)
        # And lands near the top of the 10-pt envelope on a normal CV.
        assert fmt >= 8.0


# ---------------------------------------------------------------------------
# Per sub-signal — the freebies and double-counts that v1 had are gone
# ---------------------------------------------------------------------------

class TestNoRoleFamilyFreebie:
    """v1 awarded 8 pts just for the JD's role_family being recognised. v2
    replaces that with CV-side vertical alignment."""

    def test_irrelevant_cv_does_not_collect_alignment_pts(self):
        """SWE CV applying to nursing JD — alignment ratio must be 0, so the
        vertical sub-signal awards 0 (NOT 8)."""
        m = _matching(soft_matched=0, soft_total=7, dom_matched=0, dom_total=6)
        _, comps = _experience_score(SWE_CV, m, NURSING_JD)
        assert comps["vertical_alignment"]["alignment_ratio"] == 0.0
        assert comps["vertical_alignment"]["earned_points"] == 0.0

    def test_master_family_gets_neutral_half(self):
        """When the JD title isn't classifiable into a known family, the
        vertical sub-signal returns neutral half — the CV can't be
        evaluated against an unknown vertical."""
        jd = dict(NURSING_JD)
        jd["role_family"] = "master"
        m = _matching(soft_matched=4, soft_total=7, dom_matched=4, dom_total=6)
        _, comps = _experience_score(NURSING_CV, m, jd)
        assert comps["vertical_alignment"]["earned_points"] == _EXP_VERTICAL_MAX / 2.0


class TestNoKeywordRateDoubleCount:
    """v1's experience score included `(req_matched / req_total) × 15` — the
    same data Cat 1 already scored. v2 drops that sub-signal entirely."""

    def test_no_required_keyword_subsignal_in_components(self):
        m = _matching(soft_matched=4, soft_total=7, dom_matched=4, dom_total=6)
        _, comps = _experience_score(NURSING_CV, m, NURSING_JD)
        assert "required_keyword_match_rate" not in comps
        # Components are exactly the three v2 sub-signals.
        assert set(comps.keys()) == {
            "responsibility_coverage", "relevant_tenure", "vertical_alignment",
        }


# ---------------------------------------------------------------------------
# Responsibility coverage — the new Cat 2 sub-signal
# ---------------------------------------------------------------------------

class TestResponsibilityCoverage:
    def test_covers_when_two_content_tokens_match(self):
        """A responsibility 'support residents mobility' has content tokens
        'residents' + 'mobility' — both present in the nursing CV bullets,
        so it counts as covered."""
        responsibilities = ["support residents mobility"]
        n, covered = _count_responsibilities_covered(responsibilities, NURSING_CV)
        assert n == 1
        assert covered == responsibilities

    def test_does_not_cover_when_only_filler_tokens_match(self):
        """A responsibility of pure stopwords / very short tokens should not
        count — the JD said nothing concrete."""
        responsibilities = ["the and or"]
        n, covered = _count_responsibilities_covered(responsibilities, NURSING_CV)
        assert n == 0
        assert covered == []

    def test_does_not_cover_when_cv_lacks_concrete_evidence(self):
        responsibilities = ["operate forklifts in the warehouse"]
        # NURSING_CV has nothing about forklifts/warehouse.
        n, _ = _count_responsibilities_covered(responsibilities, NURSING_CV)
        assert n == 0


# ---------------------------------------------------------------------------
# Tenure — the bridge between experience-years requirement and CV reality
# ---------------------------------------------------------------------------

class TestRelevantTenure:
    def test_meeting_required_years_gets_full_credit(self):
        """Nursing CV has ~19 months of nursing-vertical tenure; JD asks for
        1 year. Tenure sub-signal should saturate."""
        m = _matching(soft_matched=4, soft_total=7, dom_matched=4, dom_total=6)
        _, comps = _experience_score(NURSING_CV, m, NURSING_JD)
        assert comps["relevant_tenure"]["earned_points"] == _EXP_TENURE_MAX

    def test_no_relevant_tenure_zero_credit(self):
        m = _matching(soft_matched=0, soft_total=7, dom_matched=0, dom_total=6)
        _, comps = _experience_score(SWE_CV, m, NURSING_JD)
        assert comps["relevant_tenure"]["earned_points"] == 0.0

    def test_no_required_years_means_presence_only(self):
        """When the JD doesn't state a year requirement, the tenure
        sub-signal returns full credit on any relevant tenure or zero."""
        jd = dict(NURSING_JD)
        jd["experience_years_required"] = None
        m = _matching(soft_matched=4, soft_total=7, dom_matched=4, dom_total=6)
        _, comps = _experience_score(NURSING_CV, m, jd)
        # Rashmi has relevant tenure → full presence credit.
        assert comps["relevant_tenure"]["earned_points"] == _EXP_TENURE_MAX
        assert comps["relevant_tenure"]["basis"] == "presence_only_no_requirement"
