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
        # real care skills stay; aged care is now stripped as a sector label (Phase C)
        assert "aged care" not in result["required_skills"]["domain_knowledge"]
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
        # aged care is now a sector label stripped everywhere (Phase C)
        assert "aged care" not in domain
        assert "personal care" in domain


# ---------------------------------------------------------------------------
# Aged-care-specific police-check noise (OLC Care regression, 2026-06-12)
# ---------------------------------------------------------------------------

AGED_CARE_POLICE_CHECK_VARIANTS = [
    "police check for aged care",
    "police check for working in aged care",
    "police check for working with vulnerable people",
    "national police check for aged care",
    "national police check for working in aged care",
]


@pytest.mark.parametrize("phrase", AGED_CARE_POLICE_CHECK_VARIANTS)
def test_aged_care_police_check_variants_are_noise(phrase):
    """OLC Care PCW regression: 'police check for working in aged care' was
    being extracted as a Required Care Skill instead of routing to the
    credential sidecar. These long-form variants are credentials that
    match against the user's profile, not skills."""
    result = is_noise(phrase)
    assert result is not None, f"Expected noise classification but got None for: {phrase!r}"
    # All these route through the 'credential' sidecar — verifies they go to
    # the right collection downstream.
    assert result == "credential", (
        f"Expected 'credential' classification, got {result!r} for {phrase!r}."
    )


# ---------------------------------------------------------------------------
# 4. Credential gap report (_build_credentials_gap) — sources the deterministic
#    jd_analysis["credentials"] block, marks present/missing against CV+profile.
# ---------------------------------------------------------------------------

from app.services.pipeline.steps.cv_jd_matching import _build_credentials_gap


class TestBuildCredentialsGap:
    def _jd(self):
        return {
            "credentials": {
                "required": ["Cert III in Ageing Support", "police check for working in aged care"],
                "preferred": ["Cert IV in Ageing Support"],
                "eligibility": ["working rights in australia"],
            }
        }

    def test_missing_required_credential_surfaces(self):
        # CV has neither cert nor police check, no profile.
        gap = _build_credentials_gap(
            self._jd(), {"required": {}, "preferred": {}},
            cv_text="Experienced aged care worker.", contact_details=None,
        )
        assert "Cert III in Ageing Support" in gap["missing"]
        assert "Cert III in Ageing Support" in gap["required"]
        assert gap["present"] == []

    def test_present_credential_from_cv(self):
        gap = _build_credentials_gap(
            self._jd(), {"required": {}, "preferred": {}},
            cv_text="I hold a Cert III in Ageing Support and 5 years experience.",
            contact_details=None,
        )
        assert "Cert III in Ageing Support" in gap["present"]
        assert "Cert III in Ageing Support" not in gap["missing"]

    def test_fallback_folds_in_regex_sidecar(self):
        # No deterministic block; a credential mis-bucketed by the LLM arrives
        # via the regex sidecar and must still surface as required.
        sidecar = {
            "required": {"technical": [], "soft_skills": [], "domain_knowledge": ["cert iv aged care"]},
            "preferred": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        gap = _build_credentials_gap({}, sidecar, cv_text="", contact_details=None)
        assert "cert iv aged care" in gap["required"]
        assert "cert iv aged care" in gap["missing"]

    def test_no_credentials_yields_empty(self):
        gap = _build_credentials_gap({}, {"required": {}, "preferred": {}}, cv_text="", contact_details=None)
        assert gap["required"] == [] and gap["preferred"] == [] and gap["eligibility"] == []

    def test_cert_iv_subsumes_required_cert_iii(self):
        # JD wants Cert III in Individual Support; CV holds the higher Cert IV in
        # Ageing Support (same family) → satisfied, not missing.
        jd = {"credentials": {
            "required": ["Certificate III in Individual Support"],
            "preferred": [], "eligibility": [],
        }}
        cv = "Education\nCertificate IV in Ageing Support\nBachelor of Science"
        gap = _build_credentials_gap(jd, {"required": {}, "preferred": {}},
                                     cv_text=cv, contact_details=None)
        assert "Certificate III in Individual Support" in gap["present"]
        assert "Certificate III in Individual Support" not in gap["missing"]

    def test_subsumption_does_not_cross_family(self):
        # A Cert IV in Cleaning must NOT satisfy a Cert III in Individual Support.
        jd = {"credentials": {
            "required": ["Certificate III in Individual Support"],
            "preferred": [], "eligibility": [],
        }}
        cv = "Certificate IV in Cleaning Operations"
        gap = _build_credentials_gap(jd, {"required": {}, "preferred": {}},
                                     cv_text=cv, contact_details=None)
        assert "Certificate III in Individual Support" in gap["missing"]

    def test_subsumption_respects_level(self):
        # CV Cert III cannot satisfy a required Diploma in the same family.
        jd = {"credentials": {
            "required": ["Diploma of Community Services"],
            "preferred": [], "eligibility": [],
        }}
        cv = "Certificate III in Individual Support"
        gap = _build_credentials_gap(jd, {"required": {}, "preferred": {}},
                                     cv_text=cv, contact_details=None)
        assert "Diploma of Community Services" in gap["missing"]


class TestComputeCountsCredentialSidecar:
    """Finding #2 (chunk C18) — _extract_credential_sidecar strips
    credential-shaped keywords out of matched/missed (cv_jd_matching.py:102)
    BEFORE _compute_counts runs (:189). The numerator (matched[bucket][cat])
    reflects the stripped set; the denominator previously derived straight
    from jd_analysis[f"{bucket}_skills"] did not, requiring a separately
    threaded credentials_sidecar to correct it. That fix worked at this
    call site but the ONLY other caller of _compute_counts
    (tailored_rescoring.py) passed jd_analysis without the sidecar,
    silently reproducing the identical bug on the tailored score — found by
    independent review. _compute_counts now derives total from
    matched+missed directly (never changed by the sidecar strip or any
    promotion pass, only redistributed — see its docstring), so both call
    sites are correct with no value to thread and nothing to forget.

    Reproduces the audit's exact scenario: a genuine 3-of-3 match scored
    2-of-3 (66.7%) purely because one of the three was a credential-shaped
    keyword correctly moved out of the skill count — enough to flip
    passed_initial_gate at the default min_initial_ats=50 on nursing
    weights, while credentials_required.present reported that same
    credential as satisfied at the same time.
    """

    def _matched_after_sidecar_strip(self):
        # Simulates matched AFTER _extract_credential_sidecar already moved
        # "cert iii aged care" out — a genuine 3-of-3 CV match, one of the
        # three credential-shaped and correctly pulled from the skill count.
        return {
            "required": {
                "technical": ["wound care", "medication administration"],
                "soft_skills": [], "domain_knowledge": [],
            },
            "preferred": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }

    def _missed_after_sidecar_strip(self):
        # The credential is gone from missed too (stripped from BOTH lists),
        # not just absent from matched — this is what makes matched+missed
        # the true post-strip total instead of the unstripped JD count.
        return {
            "required": {"technical": [], "soft_skills": [], "domain_knowledge": []},
            "preferred": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }

    def test_total_derived_from_matched_plus_missed_excludes_stripped_credential(self):
        from app.services.pipeline.steps.cv_jd_matching import _compute_counts

        counts = _compute_counts(
            self._matched_after_sidecar_strip(), self._missed_after_sidecar_strip(),
        )
        assert counts["required"]["technical"] == {"matched": 2, "total": 2}
        assert counts["totals"] == {"matched": 2, "total": 2}

    def test_bucket_and_category_scoped_not_blind(self):
        # Independent review (round 1) found a bucket-blind subtraction
        # variant that survived the old tests because every fixture only
        # populated "required" — "preferred" was always empty. Different
        # matched/missed counts per bucket/category here would produce a
        # wrong "totals" sum if any cross-bucket/category blending crept in.
        from app.services.pipeline.steps.cv_jd_matching import _compute_counts

        matched = {
            "required": {"technical": ["a"], "soft_skills": [], "domain_knowledge": []},
            "preferred": {"technical": [], "soft_skills": ["b", "c"], "domain_knowledge": []},
        }
        missed = {
            "required": {"technical": [], "soft_skills": ["d"], "domain_knowledge": []},
            "preferred": {"technical": ["e"], "soft_skills": [], "domain_knowledge": []},
        }
        counts = _compute_counts(matched, missed)
        assert counts["required"]["technical"] == {"matched": 1, "total": 1}
        assert counts["required"]["soft_skills"] == {"matched": 0, "total": 1}
        assert counts["preferred"]["technical"] == {"matched": 0, "total": 1}
        assert counts["preferred"]["soft_skills"] == {"matched": 2, "total": 2}
        assert counts["totals"] == {"matched": 3, "total": 5}

    def test_real_pipeline_call_site_passes_missed(self):
        # End-to-end guard: someone "simplifying" the call site or reverting
        # to the old jd_analysis-based signature would silently reintroduce
        # the asymmetry bug. Assert the source actually calls it correctly.
        import inspect

        from app.services.pipeline.steps import cv_jd_matching

        src = inspect.getsource(cv_jd_matching.run_cv_jd_matching)
        assert '_compute_counts(result["matched"], result["missed"])' in src

    def test_tailored_rescoring_call_site_uses_same_signature(self):
        # The bug independent review actually found: this call site used to
        # pass jd_analysis (no sidecar), silently deflating the tailored
        # score relative to the now-fixed original. Guard both call sites
        # stay symmetric.
        import inspect
        import re

        from app.services.pipeline.steps import tailored_rescoring

        src = inspect.getsource(tailored_rescoring.run_tailored_rescoring)
        call = re.search(r'_compute_counts\(\s*([^)]*?)\s*\)', src, re.DOTALL)
        assert call is not None, "no _compute_counts call found in run_tailored_rescoring"
        args = [a.strip() for a in call.group(1).split(",")]
        assert args == ['tailored_matching["matched"]', 'tailored_matching["missed"]']

    def test_tailored_score_not_deflated_by_stripped_credential(self):
        # Independent review's exact finding: with the ORIGINAL call site
        # fixed but tailored_rescoring's left passing jd_analysis (unstripped,
        # still contains the credential keyword) instead of missed, the
        # tailored denominator for "required.technical" would be 3 (JD count)
        # while the original's was correctly 2 (post-strip) — deflating the
        # tailored score below the original even though nothing regressed.
        from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring

        jd_analysis = {
            "required_skills": {
                # 3 keywords in the raw JD; "cert iii aged care" is
                # credential-shaped and was stripped out of matching's
                # matched/missed by cv_jd_matching before this ran — mirrors
                # the real pipeline, where jd_analysis itself is never
                # mutated by the sidecar strip.
                "technical": ["wound care", "medication administration", "cert iii aged care"],
                "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        matching = {
            "matched": {
                "required": {
                    "technical": ["wound care", "medication administration"],
                    "soft_skills": [], "domain_knowledge": [],
                },
                "preferred": {"technical": [], "soft_skills": [], "domain_knowledge": []},
            },
            "missed": {
                "required": {"technical": [], "soft_skills": [], "domain_knowledge": []},
                "preferred": {"technical": [], "soft_skills": [], "domain_knowledge": []},
            },
            "raw_match_score": 80,
        }
        feasibility = {"feasibility_plan": {
            "inject_directly": [], "inject_as_extension": [], "inject_with_inference": [],
            "cannot_inject": [],
        }, "summary": {}}
        original_ats = {"overall_score": 60, "formatting_score": 15}
        tailored_md = "## Skills\n\n- **Care Skills:** Wound Care, Medication Administration\n"

        result = run_tailored_rescoring(
            tailored_md, jd_analysis, matching, feasibility, original_ats,
        )
        counts = result["tailored_ats_scoring_result"]["counts"]
        # Post-fix: total comes from matched+missed (2), matching the
        # original's own count — NOT the raw JD's unstripped 3.
        assert counts["required"]["technical"] == {"matched": 2, "total": 2}
        # Nothing was injected or removed — the tailored CV cannot honestly
        # score below the original on keyword coverage.
        assert result["ats_lift"] >= 0
