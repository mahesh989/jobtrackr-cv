"""Sprint L — profile credential promotion in CV-JD matching.

Verifies that keywords the matcher flags as 'missed' are promoted to 'matched'
when the user's profile already satisfies them (police check, work rights,
first aid, vaccination, etc.).

Before Sprint L these appeared as 'Missing Keywords' in the matching panel even
though the feasibility planner marked them inject_directly via profile stamps.
"""
from app.services.pipeline.steps.cv_jd_matching import _promote_profile_credentials
from app.services.pipeline.steps.keyword_feasibility import user_has_credential

_CONTACT_WITH_CREDS = {
    "credentials": {
        "police_check": "National Police Check",
        "work_rights": "Visa with work rights",
        "first_aid": "HLTAID011",
        "flu_vaccination": "Yes",
        "covid_vaccination": "Yes",
        "medication_competency": "Yes",
        "drivers_licence": "Open",
        "own_car": True,
    }
}

_CONTACT_NO_CREDS = {}


def _empty_matching():
    cats = ("technical", "soft_skills", "domain_knowledge")
    buckets = ("required", "preferred")
    return {
        b: {c: [] for c in cats}
        for b in buckets
    }


class TestPromoteProfileCredentials:

    def test_police_check_promoted_from_missed(self):
        matched = _empty_matching()
        missed = _empty_matching()
        missed["required"]["technical"] = ["national police check"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert "national police check" in promoted
        assert "national police check" in matched["required"]["technical"]
        assert "national police check" not in missed["required"]["technical"]

    def test_work_rights_promoted(self):
        matched = _empty_matching()
        missed = _empty_matching()
        missed["preferred"]["domain_knowledge"] = ["work rights"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert "work rights" in promoted

    def test_first_aid_promoted(self):
        matched = _empty_matching()
        missed = _empty_matching()
        missed["required"]["technical"] = ["first aid certificate"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert "first aid certificate" in promoted

    def test_flu_vaccination_promoted(self):
        matched = _empty_matching()
        missed = _empty_matching()
        missed["required"]["technical"] = ["influenza vaccination"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert "influenza vaccination" in promoted

    def test_real_skill_not_promoted(self):
        """wound care is a real skill, not a credential — must stay missed."""
        matched = _empty_matching()
        missed = _empty_matching()
        missed["required"]["domain_knowledge"] = ["wound care"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert "wound care" not in promoted
        assert "wound care" in missed["required"]["domain_knowledge"]

    def test_no_contact_details_promotes_nothing(self):
        matched = _empty_matching()
        missed = _empty_matching()
        missed["required"]["technical"] = ["national police check", "first aid"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_NO_CREDS, user_has_credential
        )
        assert promoted == []
        assert len(missed["required"]["technical"]) == 2

    def test_multiple_credentials_across_buckets(self):
        matched = _empty_matching()
        missed = _empty_matching()
        missed["required"]["technical"] = ["national police check", "influenza vaccination"]
        missed["preferred"]["technical"] = ["work rights"]
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert len(promoted) == 3
        assert not missed["required"]["technical"]
        assert not missed["preferred"]["technical"]

    def test_no_duplication_if_already_matched(self):
        """If a keyword is already in matched it won't be in missed (reconcile
        ensures disjoint sets), so there's nothing to promote — sanity check."""
        matched = _empty_matching()
        missed = _empty_matching()
        matched["required"]["technical"] = ["national police check"]
        # missed is empty for police check
        promoted = _promote_profile_credentials(
            matched, missed, _CONTACT_WITH_CREDS, user_has_credential
        )
        assert "national police check" not in promoted
        # matched still has it exactly once
        assert matched["required"]["technical"].count("national police check") == 1


class TestAhpraRegistration:
    """AHPRA registration is satisfied by a saved ahpra_number on the profile."""

    _WITH_AHPRA = {"credentials": {"ahpra_number": "NMW0001234567"}}
    _NO_AHPRA = {"credentials": {}}

    def test_ahpra_registration_satisfied(self):
        assert user_has_credential("AHPRA registration", self._WITH_AHPRA) is True

    def test_registered_nurse_registration_satisfied(self):
        assert user_has_credential(
            "current registration as a registered nurse", self._WITH_AHPRA
        ) is True

    def test_not_satisfied_without_ahpra_number(self):
        assert user_has_credential("AHPRA registration", self._NO_AHPRA) is False

    def test_generic_registration_does_not_match(self):
        # Unrelated "registration" must not be satisfied by an AHPRA number.
        assert user_has_credential("software registration", self._WITH_AHPRA) is False

    def test_registration_with_nurse_substring_does_not_misfire(self):
        # Word-boundary guard: "nurse" as a substring of another token must not
        # satisfy AHPRA (e.g. a contrived "nursery vehicle registration").
        assert user_has_credential(
            "nursery vehicle registration", self._WITH_AHPRA
        ) is False

    def test_midwifery_registration_satisfied(self):
        assert user_has_credential(
            "current midwifery registration", self._WITH_AHPRA
        ) is True
