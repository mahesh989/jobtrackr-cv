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
