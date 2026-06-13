"""Phase 2B — credential synonym table for the injection verifier.

Conservative AU-aged-care synonyms: every entry is an equivalence any
AU recruiter would accept. JD wording → CV-side evidence.

Source bugs across multiple runs:
  - "nsw c class motor vehicle licence" → user has "Driver Licence (Open)"
  - "first aid certificate" → user has "First Aid (HLTAID011)"
  - "cpr certificate" → HLTAID011 includes CPR competency by AU standard
  - "flu vaccination" → user has "Influenza Vaccination"
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_rescoring import _kw_present


class TestDriverLicenceSynonyms:
    """C class motor vehicle licence is the standard AU car driver licence."""

    def test_nsw_c_class_matches_driver_licence(self):
        cv = "Registration: Driver Licence (Open)"
        assert _kw_present("nsw c class motor vehicle licence", cv.lower())

    def test_nsw_c_class_driver_licence_matches(self):
        cv = "Drivers Licence on file"
        assert _kw_present("nsw c class driver licence", cv.lower())

    def test_driver_license_american_spelling_matches(self):
        cv = "Driver License (Open)"
        assert _kw_present("nsw c class motor vehicle licence", cv.lower())

    def test_no_licence_in_cv_returns_false(self):
        cv = "Just some skills here"
        assert not _kw_present("nsw c class motor vehicle licence", cv.lower())


class TestFirstAidSynonyms:
    """First Aid Certificate ≡ HLTAID011 ≡ First Aid (HLTAID011)."""

    def test_first_aid_certificate_matches_hltaid(self):
        cv = "First Aid (HLTAID011)"
        assert _kw_present("first aid certificate", cv.lower())

    def test_first_aid_certification_matches_hltaid(self):
        cv = "First Aid (HLTAID011)"
        assert _kw_present("first aid certification", cv.lower())

    def test_first_aid_bare_token_matches(self):
        # The suffix-strip retry handles this independently; verify it
        # still works alongside the synonym map.
        cv = "Skills include first aid and medication administration"
        assert _kw_present("first aid certificate", cv.lower())


class TestCprViaFirstAid:
    """HLTAID011 includes CPR competency by AU national standard.

    AU recruiters accept First Aid (HLTAID011) as proof of CPR ability:
    HLTAID011 ("Provide First Aid") supersedes/includes HLTAID009
    ("Provide CPR"). This synonym is honest — the candidate genuinely
    holds CPR competency via HLTAID011."""

    def test_cpr_certificate_matches_hltaid(self):
        cv = "First Aid (HLTAID011) · Medication Competency"
        assert _kw_present("cpr certificate", cv.lower())

    def test_cpr_certification_matches_hltaid(self):
        cv = "First Aid (HLTAID011)"
        assert _kw_present("cpr certification", cv.lower())

    def test_cpr_returns_false_when_no_first_aid_either(self):
        cv = "Skills: Personal Care, Dementia Care"
        assert not _kw_present("cpr certificate", cv.lower())


class TestVaccinationSynonyms:
    """Flu ≡ Influenza in AU clinical settings."""

    def test_flu_vaccination_matches_influenza(self):
        cv = "Influenza Vaccination · COVID-19 Vaccination"
        assert _kw_present("flu vaccination", cv.lower())

    def test_influenza_vaccination_matches_flu(self):
        cv = "Flu Vaccination on file"
        assert _kw_present("influenza vaccination", cv.lower())


class TestWorkingRightsSynonyms:

    def test_australian_working_rights_matches_work_rights(self):
        cv = "Work Rights (Visa with work rights)"
        assert _kw_present("australian working rights", cv.lower())

    def test_australian_work_rights_matches_work_rights(self):
        cv = "Work Rights (Visa with work rights)"
        assert _kw_present("australian work rights", cv.lower())


class TestPoliceCheckSynonyms:

    def test_police_check_matches_national_police_check(self):
        cv = "National Police Check · First Aid"
        assert _kw_present("police check", cv.lower())

    def test_national_police_check_matches_police_clearance(self):
        cv = "Skills include Police Clearance"
        assert _kw_present("national police check", cv.lower())


class TestNonSynonymsStillFail:
    """Negative cases — concepts NOT in the synonym map must still return
    False. Keeps us honest: the map only contains true equivalences."""

    def test_ndis_workers_check_not_matched_by_police_check(self):
        # NDIS Workers Check ≠ Police Check (different credential).
        cv = "National Police Check on file"
        assert not _kw_present("ndis workers check", cv.lower())

    def test_disability_support_not_matched_by_aged_care(self):
        cv = "Aged care experience for 5 years"
        assert not _kw_present("disability support", cv.lower())

    def test_sara_steady_no_synonym(self):
        cv = "Manual handling protocols"
        assert not _kw_present("sara steady", cv.lower())

    def test_commitment_not_matched_by_dedicated(self):
        # Soft-skill morphology deliberately NOT in map (too error-prone).
        cv = "Dedicated care worker"
        assert not _kw_present("commitment", cv.lower())


class TestPriorityIsLiteralThenSuffixThenSynonym:
    """Verify the matcher tries literal → suffix-strip → synonym in order."""

    def test_literal_match_short_circuits(self):
        cv = "police check"
        assert _kw_present("police check", cv.lower())

    def test_suffix_strip_before_synonym(self):
        # "first aid certificate" → "first aid" via suffix-strip matches
        # before the synonym map is consulted.
        cv = "first aid"
        assert _kw_present("first aid certificate", cv.lower())


class TestApostropheDriverLicenseVariants:
    """Sprint G hotfix: JDs use 'driver's license' with apostrophe and
    American spelling. The synonym keys are exact-match, so each
    common phrasing must have its own entry."""

    def test_valid_australian_drivers_license_apostrophe(self):
        cv = "Registration: Driver Licence (Open)"
        assert _kw_present("valid australian driver's license", cv.lower())

    def test_valid_australian_drivers_license_no_apostrophe(self):
        cv = "Driver Licence (Open)"
        assert _kw_present("valid australian drivers license", cv.lower())

    def test_australian_drivers_license_apostrophe(self):
        cv = "Driver Licence (Open)"
        assert _kw_present("australian driver's license", cv.lower())


class TestQualifierStripping:
    """Sprint I: JD-side qualifier words ('current', 'valid', 'accredited')
    must not block synonym lookup. JDs commonly prepend these to credential
    names without changing what the credential IS."""

    def test_current_accredited_first_aid_certificate(self):
        # The exact post-Sprint-H Anglicare bug.
        cv = "Registration & Licences: First Aid (HLTAID011)"
        assert _kw_present("current accredited first aid certificate", cv.lower())

    def test_current_cpr_certificate(self):
        # CPR via HLTAID011 + qualifier strip.
        cv = "First Aid (HLTAID011)"
        assert _kw_present("current cpr certificate", cv.lower())

    def test_valid_drivers_license(self):
        cv = "Driver Licence (Open)"
        assert _kw_present("valid drivers license", cv.lower())

    def test_accredited_first_aid(self):
        cv = "First Aid Training Certificate"
        # 'accredited first aid' → strip 'accredited' → 'first aid' → matches.
        assert _kw_present("accredited first aid", cv.lower())

    def test_up_to_date_police_check(self):
        cv = "National Police Check"
        assert _kw_present("up-to-date police check", cv.lower())

    def test_multiple_qualifiers_stripped(self):
        # 'current valid accredited' all strip.
        cv = "First Aid (HLTAID011)"
        assert _kw_present("current valid accredited first aid certificate", cv.lower())

    def test_qualifier_alone_does_not_match(self):
        # Stripping shouldn't make 'current' alone into a match.
        cv = "Random text"
        assert not _kw_present("current", cv.lower())

    def test_unrelated_word_starting_with_qualifier_substring(self):
        # 'currency' starts with 'curren' but not 'current ' (with space).
        # The qualifier list keys are word + space, so 'currency exchange'
        # doesn't lose 'currency'.
        cv = "skills: currency exchange"
        assert _kw_present("currency exchange", cv.lower())


class TestSynonymOverridesHonestGap:
    """Sprint I+: when a feasibility-classified honest gap has a CURATED
    synonym present in the tailored CV, override the gap classification.
    The synonym map is authoritative for credential equivalences
    (HLTAID011 ≡ CPR by AU national standard) — feasibility AI doesn't
    know these and the curated map should win."""

    def test_cpr_honest_gap_overridden_when_hltaid_in_cv(self):
        from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring

        tailored_md = """
## Registration & Licences

First Aid (HLTAID011) · Medication Competency

## Skills

- **Care Skills:** Personal Care, Dementia Care
""".lstrip()

        jd_analysis = {
            "required_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
            "preferred_skills": {
                "technical": ["cpr certification"],
                "soft_skills": [],
                "domain_knowledge": [],
            },
        }
        matching = {
            "matched": {"required": {}, "preferred": {}},
            "missed": {
                "required": {},
                "preferred": {
                    "technical": ["cpr certification"],
                    "soft_skills": [],
                    "domain_knowledge": [],
                },
            },
            "counts": {
                "required": {},
                "preferred": {"technical": {"matched": 0, "total": 1}},
            },
            "raw_match_score": 60,
        }
        feasibility = {
            "feasibility_plan": {
                "inject_directly": [],
                "inject_as_extension": [],
                "inject_with_inference": [],
                "cannot_inject": [
                    {"keyword": "cpr certification",
                     "category": "technical",
                     "bucket": "preferred",
                     "reason": "no cpr in cv"},
                ],
            },
            "summary": {},
        }
        original_ats = {"overall_score": 50}

        result = run_tailored_rescoring(
            tailored_md, jd_analysis, matching, feasibility, original_ats,
        )
        # 'cpr certification' must be credited (HLTAID011 in CV) and removed
        # from honest gaps.
        assert "cpr certification" in result["injected_keywords"]
        assert "cpr certification" not in result["honest_gaps"]

    def test_cpr_stays_honest_gap_when_no_hltaid(self):
        from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring

        tailored_md = """
## Skills

- **Care Skills:** Personal Care
""".lstrip()

        jd_analysis = {
            "required_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
            "preferred_skills": {"technical": ["cpr certification"], "soft_skills": [], "domain_knowledge": []},
        }
        matching = {
            "matched": {"required": {}, "preferred": {}},
            "missed": {
                "required": {},
                "preferred": {"technical": ["cpr certification"], "soft_skills": [], "domain_knowledge": []},
            },
            "counts": {"required": {}, "preferred": {"technical": {"matched": 0, "total": 1}}},
            "raw_match_score": 60,
        }
        feasibility = {
            "feasibility_plan": {
                "inject_directly": [],
                "inject_as_extension": [],
                "inject_with_inference": [],
                "cannot_inject": [
                    {"keyword": "cpr certification",
                     "category": "technical",
                     "bucket": "preferred",
                     "reason": "no cpr"},
                ],
            },
            "summary": {},
        }
        original_ats = {"overall_score": 50}

        result = run_tailored_rescoring(
            tailored_md, jd_analysis, matching, feasibility, original_ats,
        )
        # No HLTAID011 in CV → stays in honest gaps.
        assert "cpr certification" in result["honest_gaps"]
        assert "cpr certification" not in result["injected_keywords"]


class TestFabricationCheckLiteralOnly:
    """Sprint G hotfix: fabrication detection must use LITERAL match only,
    NOT the credit-side synonym map. Otherwise an honest gap that gets
    'credited' via a synonym (e.g. CPR via HLTAID011) ALSO shows up as
    fabricated → contradictory UI state."""

    def test_literal_match_helper_does_not_use_synonyms(self):
        from app.services.pipeline.steps.tailored_rescoring import _literal_match
        # 'cpr' is NOT literally in this CV (only HLTAID011 is) — fabrication
        # check uses _literal_match so this returns False.
        cv = "first aid (hltaid011) · medication competency"
        assert not _literal_match("cpr", cv)
        assert not _literal_match("cpr certification", cv)
        # But the credit path (which uses _kw_present with synonyms) DOES
        # match — verified by Phase 2B tests already.
        assert _kw_present("cpr certification", cv)
