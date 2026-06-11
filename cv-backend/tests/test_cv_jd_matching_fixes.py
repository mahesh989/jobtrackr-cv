"""Regression tests for cv_jd_matching fixes.

Covers:
  1. Literal-string promotion (_promote_literal_matches) — AI missed a
     keyword that verbatim appears in cv_text (e.g. "communication").
  2. Vaccination-requirements noise — these are credentials, not care skills.
  3. Nursing-fundamentals noise — student/filler phrase, not a skill.
"""
from __future__ import annotations

import pytest

from app.services.pipeline.steps.cv_jd_matching import (
    _BUCKETS,
    _CATEGORIES,
    _literal_match_in_text,
    _promote_literal_matches,
)
from app.services.skills.classifier import is_noise
from app.services.skills.post_process import post_process_jd_analysis


# ---------------------------------------------------------------------------
# 1. Literal-match promotion
# ---------------------------------------------------------------------------

def _empty_block():
    return {b: {c: [] for c in _CATEGORIES} for b in _BUCKETS}


class TestLiteralMatchInText:
    def test_exact_word(self):
        assert _literal_match_in_text("communication", "strong communication skills") is True

    def test_not_a_substring_of_another_word(self):
        # "ai" must NOT match inside "fair" or "training"
        assert _literal_match_in_text("ai", "fair training environment") is False

    def test_multiword_phrase(self):
        assert _literal_match_in_text("time management", "demonstrates time management daily") is True

    def test_missing(self):
        assert _literal_match_in_text("empathy", "no soft skills here") is False

    def test_case_insensitive(self):
        assert _literal_match_in_text("teamwork", "Strong Teamwork and collaboration") is True

    def test_special_chars(self):
        assert _literal_match_in_text("ci/cd", "experience with CI/CD pipelines") is True


class TestPromoteLiteralMatches:
    def test_promotes_exact_missed_keyword(self):
        matched = _empty_block()
        missed = _empty_block()
        missed["required"]["soft_skills"] = ["communication", "teamwork"]
        cv = "Excellent communication and adaptability in all settings."

        promoted = _promote_literal_matches(matched, missed, cv)

        assert "communication" in promoted
        assert "communication" in matched["required"]["soft_skills"]
        assert "communication" not in missed["required"]["soft_skills"]
        # teamwork not in cv → stays missed
        assert "teamwork" not in promoted
        assert "teamwork" in missed["required"]["soft_skills"]

    def test_no_false_positives(self):
        matched = _empty_block()
        missed = _empty_block()
        missed["required"]["domain_knowledge"] = ["acute care"]
        cv = "Worked in residential aged care facility providing personal care."

        promoted = _promote_literal_matches(matched, missed, cv)
        assert "acute care" not in promoted

    def test_empty_cv_text(self):
        matched = _empty_block()
        missed = _empty_block()
        missed["required"]["soft_skills"] = ["empathy"]
        promoted = _promote_literal_matches(matched, missed, "")
        assert promoted == []

    def test_multiword_keyword(self):
        matched = _empty_block()
        missed = _empty_block()
        missed["required"]["domain_knowledge"] = ["person-centred care"]
        cv = "Provided person-centred care to all residents."

        promoted = _promote_literal_matches(matched, missed, cv)
        assert "person-centred care" in promoted

    def test_promotes_across_buckets(self):
        matched = _empty_block()
        missed = _empty_block()
        missed["preferred"]["soft_skills"] = ["adaptability"]
        cv = "Demonstrated adaptability across different shifts."

        promoted = _promote_literal_matches(matched, missed, cv)
        assert "adaptability" in promoted
        assert "adaptability" in matched["preferred"]["soft_skills"]


# ---------------------------------------------------------------------------
# 2. Vaccination-requirements noise
# ---------------------------------------------------------------------------

VACCINATION_NOISE_VARIANTS = [
    "vaccination requirements",
    "vaccination requirement",
    "immunisation requirements",
    "immunisation requirement",
    "immunization requirements",
    "immunization requirement",
]


@pytest.mark.parametrize("phrase", VACCINATION_NOISE_VARIANTS)
def test_vaccination_requirements_is_noise(phrase):
    """These are credential/eligibility prerequisites, not skills."""
    result = is_noise(phrase)
    assert result is not None, f"Expected noise but got None for: {phrase!r}"


class TestVaccinationRemovedFromJdAnalysis:
    def test_vaccination_requirements_stripped_from_care_skills(self):
        jd = {
            "job_title": "ain",
            "role_family": "nursing",
            "required_skills": {
                "technical": [],
                "soft_skills": ["communication"],
                "domain_knowledge": [
                    "aged care",
                    "personal care",
                    "vaccination requirements",
                ],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        result = post_process_jd_analysis(jd, role_family_id="nursing")
        all_skills = (
            result["required_skills"]["domain_knowledge"]
            + result["preferred_skills"]["domain_knowledge"]
        )
        assert "vaccination requirements" not in all_skills
        # real care skills stay
        assert "aged care" in result["required_skills"]["domain_knowledge"]
        assert "personal care" in result["required_skills"]["domain_knowledge"]


# ---------------------------------------------------------------------------
# 3. Nursing-fundamentals noise
# ---------------------------------------------------------------------------

NURSING_FUNDAMENTAL_VARIANTS = [
    "nursing fundamentals",
    "fundamentals of nursing",
    "fundamental nursing skills",
    "basic nursing fundamentals",
    "fundamental clinical nursing skills",
]


@pytest.mark.parametrize("phrase", NURSING_FUNDAMENTAL_VARIANTS)
def test_nursing_fundamentals_is_noise(phrase):
    """Student/filler phrases — not a hireable skill."""
    result = is_noise(phrase)
    assert result is not None, f"Expected noise but got None for: {phrase!r}"


class TestNursingFundamentalsRemovedFromJdAnalysis:
    def test_nursing_fundamentals_stripped(self):
        jd = {
            "job_title": "ain",
            "role_family": "nursing",
            "required_skills": {
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": [
                    "aged care",
                    "nursing fundamentals",
                    "personal care",
                ],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        result = post_process_jd_analysis(jd, role_family_id="nursing")
        domain = result["required_skills"]["domain_knowledge"]
        assert "nursing fundamentals" not in domain
        assert "aged care" in domain
        assert "personal care" in domain
