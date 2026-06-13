"""Honest-attribution fixes for the Professional Summary composer.

User-reported fabrications on a real Australian Unity AIN run with Rashmi's
CV (Rashmi has aged-care experience ONLY — Uniting, Jesmond, Anglicare):

  Fabricated S1: "experience across residential aged care and acute
                  clinical settings"  ← she has ZERO acute experience.
  Fabricated S2: "Currently delivering care at Uniting using BESTMed
                  and MedMobile."     ← those tools were used at Jesmond,
                                        NOT at Uniting.

Three fixes covered here:
  1. _tools_attributable_to_employer — only attribute a tool to an employer
     when the CV's section for THAT employer actually mentions the tool.
  2. _cv_has_hospital_experience — gates the HOSPITAL bridge so a pure
     aged-care candidate doesn't get "and acute clinical settings" appended.
  3. _classify_jd_setting — tightened HOSPITAL signal tiers so a corporate
     boilerplate "acute care" mention can't promote a residential AIN JD.
"""
from __future__ import annotations

from app.services.eval.writers import (
    _apply_setting_bridge,
    _classify_jd_setting,
    _compose_concrete_s2,
    _cv_has_hospital_experience,
    _employer_block_text,
    _tools_attributable_to_employer,
    enforce_summary_concreteness,
)


# ---------------------------------------------------------------------------
# Real-CV fixture mirroring Rashmi's structure (aged care ONLY, tools at
# Jesmond not at Uniting).
# ---------------------------------------------------------------------------

_RASHMI_CV_MD = """
# Rashmi Poudel

NSW | rashmi@example.com

## Professional Summary

Assistant in Nursing with experience across residential aged care and acute clinical settings, specialising in Activities of Daily Living support and dementia care for older adults. Currently delivering care at Uniting using BESTMed and MedMobile.

## Experience

### Uniting
Leichhardt, NSW, Australia
Assistant in Nursing (Casual)
Mar 2026 – Present
- Provide person-centred care to residents, supporting daily living.
- Monitor and report changes in residents' wellbeing.
- Maintain a safe environment, adhering to manual handling protocols.

### The Jesmond Group
Miranda, NSW, Australia
Assistant in Nursing
May 2025 – Jun 2026
- Served as primary Medication Assistant, managing electronic medication administration using BESTMed and previously MedMobile systems.
- Delivered comprehensive personal care to elderly residents.
- Collaborated with multidisciplinary teams to implement care plans.

### Anglicare Mildred Symons House
Jannali, NSW, Australia
Aged Care Placement (120 Hours)
Sept 2024
- Supported residents living with dementia using person-centred approaches.
- Executed care plans under supervision.

## Skills

Care Skills: Person-Centred Care, Dementia Care, Manual Handling
""".lstrip()


# ---------------------------------------------------------------------------
# Fix 1 — Tool-employer attribution
# ---------------------------------------------------------------------------


class TestEmployerBlockExtraction:
    def test_uniting_block_excludes_jesmond_content(self):
        block = _employer_block_text(_RASHMI_CV_MD, "Uniting")
        assert "Uniting" in block
        assert "person-centred care" in block.lower()
        # The Jesmond bullets (with BESTMed) must NOT leak into Uniting's block.
        assert "BESTMed" not in block
        assert "MedMobile" not in block
        assert "Jesmond" not in block

    def test_jesmond_block_contains_tools(self):
        block = _employer_block_text(_RASHMI_CV_MD, "The Jesmond Group")
        assert "Jesmond" in block
        assert "BESTMed" in block
        assert "MedMobile" in block

    def test_unknown_employer_returns_empty(self):
        assert _employer_block_text(_RASHMI_CV_MD, "Nonexistent Hospital") == ""


class TestToolEmployerAttribution:
    def test_uniting_gets_no_tools_when_tools_used_at_jesmond(self):
        """The core fix: BESTMed/MedMobile were used at Jesmond, not Uniting.
        Attribution must NOT pretend they were used at Uniting."""
        attributable = _tools_attributable_to_employer(
            _RASHMI_CV_MD, _RASHMI_CV_MD, "Uniting",
            ["BESTMed", "MedMobile"],
        )
        assert attributable == []

    def test_jesmond_keeps_its_own_tools(self):
        attributable = _tools_attributable_to_employer(
            _RASHMI_CV_MD, _RASHMI_CV_MD, "The Jesmond Group",
            ["BESTMed", "MedMobile"],
        )
        assert "BESTMed" in attributable
        assert "MedMobile" in attributable

    def test_empty_tools_returns_empty(self):
        assert _tools_attributable_to_employer(
            _RASHMI_CV_MD, _RASHMI_CV_MD, "Uniting", [],
        ) == []


class TestEnforceSummaryConcretenessHonesty:
    def test_does_not_attribute_jesmond_tools_to_uniting(self):
        """End-to-end: enforce_summary_concreteness must not produce
        'Currently delivering care at Uniting using BESTMed and MedMobile.'
        when the tools were used at a different employer."""
        # Start with a GENERIC S2 that triggers replacement (i.e. no employer
        # or tool token in S2 already).
        md = """
# Rashmi

## Professional Summary

Assistant in Nursing. Provides safe, respectful support for older people.

## Experience

### Uniting
Leichhardt, NSW
Assistant in Nursing (Casual)
Mar 2026 – Present
- Provide person-centred care to residents.

### The Jesmond Group
Miranda, NSW
Assistant in Nursing
May 2025 – Jun 2026
- Managed electronic medication using BESTMed and MedMobile.
""".lstrip()
        out = enforce_summary_concreteness(md, md)
        # The composer SHOULD name Uniting (it's the Present employer) but
        # SHOULD NOT claim those tools were used at Uniting.
        assert "Uniting using BESTMed" not in out
        assert "Uniting using MedMobile" not in out
        # If the composer chose the employer-only template, that's correct.
        # Acceptable forms (any one of):
        acceptable = (
            "Recent experience at Uniting" in out
        )
        assert acceptable, f"Expected employer-only S2; got:\n{out}"


# ---------------------------------------------------------------------------
# Fix 2 — HOSPITAL bridge gated on CV evidence
# ---------------------------------------------------------------------------


class TestCvHospitalExperienceDetector:
    def test_aged_care_only_cv_returns_false(self):
        """Rashmi's CV is pure aged-care — must NOT be flagged as hospital."""
        assert _cv_has_hospital_experience(_RASHMI_CV_MD, _RASHMI_CV_MD) is False

    def test_cv_with_hospital_ward_returns_true(self):
        cv = """
## Experience

### Royal North Shore Hospital
Sydney, NSW
Enrolled Nurse — Surgical Ward
2022 – 2024
- Provided post-operative care on the orthopaedic ward.
"""
        assert _cv_has_hospital_experience(cv, cv) is True

    def test_summary_paraphrase_alone_does_not_trigger(self):
        """If the AI wrote 'acute clinical settings' in the SUMMARY only
        (no Experience evidence), the detector must NOT count that as
        candidate experience — otherwise the gate is self-fulfilling."""
        cv = """
## Professional Summary

Worked across residential aged care and acute clinical settings.

## Experience

### Some Nursing Home
2024 – Present
- Delivered personal care to elderly residents.
"""
        assert _cv_has_hospital_experience(cv, cv) is False


class TestApplySettingBridgeHonestyGate:
    _S1_MD = """
## Professional Summary

Assistant in Nursing with experience in residential aged care settings, focusing on personal care.

## Experience

### Uniting
Mar 2026 – Present
- Personal care.
""".lstrip()

    def test_hospital_bridge_skipped_when_cv_has_no_acute(self):
        from app.services.eval.writers import _SETTING_HOSPITAL
        out = _apply_setting_bridge(
            self._S1_MD, _SETTING_HOSPITAL, cv_text=_RASHMI_CV_MD,
        )
        # Bridge NOT applied → S1 stays residential, no "acute clinical".
        assert "acute clinical" not in out
        assert "residential aged care settings" in out

    def test_hospital_bridge_applied_when_cv_has_acute(self):
        from app.services.eval.writers import _SETTING_HOSPITAL
        cv_with_hospital = """
## Experience

### Royal Sydney Hospital
2020 – 2022
- Worked on the surgical ward delivering acute care.
"""
        out = _apply_setting_bridge(
            self._S1_MD, _SETTING_HOSPITAL, cv_text=cv_with_hospital,
        )
        # Bridge applied → S1 now mentions acute clinical settings.
        assert "acute clinical settings" in out


# ---------------------------------------------------------------------------
# Fix 3 — Tightened HOSPITAL classifier
# ---------------------------------------------------------------------------


class TestJdClassifierTightening:
    def test_corporate_boilerplate_acute_care_does_not_promote(self):
        """Australian Unity's JD has 'acute care' in its corporate intro but
        the role is a residential AIN. Classifier must return residential."""
        jd_text = (
            "Australian Unity is a member-owned wellbeing organisation. We "
            "deliver aged care, home care, retirement living, and acute care "
            "services across NSW. Join our household-style aged care community."
        )
        jd_analysis = {
            "job_title": "assistant in nursing",
            "summary": "Provides daily care and companionship to aged care residents.",
            "responsibilities": [
                "support residents with daily personal care",
                "build relationships with residents and families",
            ],
        }
        setting = _classify_jd_setting(jd_text, jd_analysis)
        # Residential — NOT hospital, NOT home (no "in their home" phrase).
        assert setting == "residential", (
            f"Expected residential; got {setting}. "
            f"'acute care' in JD boilerplate must not promote to HOSPITAL."
        )

    def test_strong_signal_still_promotes(self):
        """A role explicitly on a surgical ward MUST still classify as
        hospital. The tightening only removes false promotions from weak
        signals; strong signals are unchanged."""
        jd_text = "Join our surgical ward team."
        jd_analysis = {
            "job_title": "registered nurse",
            "responsibilities": ["assist surgeons on the surgical ward"],
        }
        setting = _classify_jd_setting(jd_text, jd_analysis)
        assert setting == "hospital_acute"

    def test_weak_signal_in_responsibilities_still_promotes(self):
        """When the weak phrase appears in resp0 / job_title (primary), it
        IS a real signal — the role itself is acute. Promote correctly."""
        jd_text = ""
        jd_analysis = {
            "job_title": "RN - Acute Clinical",
            "responsibilities": [
                "provide acute care to post-operative patients",
            ],
        }
        setting = _classify_jd_setting(jd_text, jd_analysis)
        assert setting == "hospital_acute"
