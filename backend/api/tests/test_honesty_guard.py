"""Honesty guard tests — anchors the tailored CV to source-CV facts.

Covers the quality issues surfaced by the real-test audit:
  1. Fabricated/placeholder dates in role italic-headers
  2. Categorical work-history hallucination (e.g. "retirement village")
  3. Wrong Skills section headline label for the JD vertical
  4. Pre-composition: irrelevant-role filter with a floor
  5. Honesty-risk flag for orchestrator decisions

Note: the "N+ years' experience" honesty rule and the summary word-floor are
now enforced at generation time in the composer prompt (ai/prompts/tailored_cv
.py), not by deterministic post-passes — see decision to fold gate intent into
the prompt (single source of truth).
"""
from __future__ import annotations

import pytest

from app.services.eval.writers.honesty_guard import (
    enforce_source_dates,
    enforce_source_settings,
    pin_skills_section_labels,
    enforce_credential_claims,
    filter_irrelevant_roles_pre,
    assess_honesty_risk,
    extract_source_facts,
)


# ---------------------------------------------------------------------------
# Source CV fixtures — anchored to Shanti's real source (3-month placement
# residential AIN + accountant + cleaner). The placeholder/fabricated values
# below mirror the actual leak patterns seen in the audit.
# ---------------------------------------------------------------------------

SHANTI_CV = """SHANTI GIRI
Hurstville, NSW

CLINICAL PLACEMENT

RFBI Concord Community Village
Aged Care Placement (120 hours)
Dec 2025 – Feb 2026
Rhodes, NSW
- Provided personal care to elderly residents, including individuals with dementia.
- Assisted with daily living activities including dressing, bathing, feeding, and mobility support.
- Collaborated with Registered Nurses and the multidisciplinary healthcare team.

WORK EXPERIENCE

Akala Motors Private Limited
Junior Accountant
Jan 2024 – May 2025
Pokhara, Nepal
- Maintained financial records and updated daily transactions.
- Processed transactions efficiently while maintaining professional client interactions.

Dimeo Cleaning Excellence
Office Cleaner
Sydney, Australia
- Maintained cleanliness of office areas including desks, floors, and meeting rooms.
- Emptied office waste bins and ensured hygienic standards.
"""


# ---------------------------------------------------------------------------
# 1. Date guard
# ---------------------------------------------------------------------------

class TestEnforceSourceDates:

    def test_placeholder_dates_stripped_when_source_has_none(self):
        """Dimeo source has no dates → tailored CV's [Dates] – [Dates]
        placeholder must be removed entirely (no date slot)."""
        tailored = """# Shanti Giri

## Professional Experience
### Dimeo Cleaning Excellence | Sydney, Australia
*Office Cleaner | [Dates] – [Dates]*

- Maintained cleanliness of office areas.
"""
        out, notes = enforce_source_dates(tailored, SHANTI_CV)
        assert "[Dates]" not in out
        assert "dates omitted" in notes[0].lower()

    def test_fabricated_dates_overwritten_with_source(self):
        """Akala source says Jan 2024 – May 2025. Tailored CV claiming
        '2023 – 2024' must be rewritten to source verbatim."""
        tailored = """# Shanti Giri

## Professional Experience
### Akala Motors Private Limited | Pokhara, Nepal
*Junior Accountant | 2023 – 2024*

- Maintained financial records.
"""
        out, notes = enforce_source_dates(tailored, SHANTI_CV)
        assert "Jan 2024" in out
        assert "May 2025" in out
        assert "2023 – 2024" not in out
        assert any("dates set to" in n.lower() for n in notes)

    def test_correct_dates_preserved(self):
        """When the tailored CV already has source-verbatim dates, no rewrite."""
        tailored = """# Shanti Giri

## Professional Experience
### Akala Motors Private Limited | Pokhara, Nepal
*Junior Accountant | Jan 2024 – May 2025*

- Bullet.
"""
        out, notes = enforce_source_dates(tailored, SHANTI_CV)
        assert out == tailored
        assert notes == []

    def test_unknown_employer_dates_stripped_when_years_not_in_source(self):
        """A tailored employer with dates whose YEARS don't appear anywhere
        in the source CV is treated as fabricated → date slot stripped."""
        tailored = """# Shanti Giri

## Professional Experience
### Mystery Employer Pty Ltd | Sydney, Australia
*Random Role | 2020 – 2021*

- Bullet.
"""
        out, notes = enforce_source_dates(tailored, SHANTI_CV)
        # 2020/2021 don't appear in Shanti's source CV → fabricated → strip.
        assert "2020 – 2021" not in out
        assert notes  # explanatory note added

    def test_unknown_employer_kept_when_years_match_source(self):
        """If the years in the tailored date DO appear in source (even on
        another employer), give the benefit of the doubt — could be a real
        employer the parser missed."""
        tailored = """# Shanti Giri

## Professional Experience
### Mystery Employer Pty Ltd | Sydney, Australia
*Random Role | Jan 2024 – May 2025*

- Bullet.
"""
        out, notes = enforce_source_dates(tailored, SHANTI_CV)
        # 2024/2025 ARE in Shanti's source → keep.
        assert "Jan 2024 – May 2025" in out
        assert notes == []

    def test_no_experience_section_in_source(self):
        out, notes = enforce_source_dates("# Some CV\n## Skills\n- x\n", "JUST A NAME\nNo experience here.")
        assert notes == []


# ---------------------------------------------------------------------------
# 2. Years-gate
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 3. Setting-descriptor guard
# ---------------------------------------------------------------------------

class TestSourceSettingsGuard:

    def test_strips_retirement_village_when_source_is_residential(self):
        """Shanti's RFBI source describes residential aged care. A tailored CV
        that calls it a 'retirement village placement' must be rewritten."""
        tailored = """# Shanti Giri

## Professional Experience
### RFBI Concord Community Village | Rhodes, NSW
*Aged Care Placement at retirement village setting | Dec 2025 – Feb 2026*

- Bullet.
"""
        out, notes = enforce_source_settings(tailored, SHANTI_CV)
        assert "retirement village" not in out.lower()
        assert any("retirement village" in n for n in notes)

    def test_preserves_setting_when_source_evidences_it(self):
        """If source role mentions 'retirement village', tailored CV can use it."""
        cv = """SHANTI GIRI

WORK EXPERIENCE

Acme Retirement Village
Care Worker
Jan 2024 – Jun 2024
Sydney, NSW
- Provided personal care in a retirement village setting.
"""
        tailored = """# Shanti Giri

## Professional Experience
### Acme Retirement Village | Sydney, NSW
*Care Worker at retirement village | Jan 2024 – Jun 2024*

- Bullet.
"""
        out, notes = enforce_source_settings(tailored, cv)
        assert "retirement village" in out.lower()
        assert notes == []


# ---------------------------------------------------------------------------
# 4. Skills-section label pin
# ---------------------------------------------------------------------------

class TestSkillsLabelPin:

    def test_relabels_technical_to_care_for_nursing(self):
        tailored = """# Shanti

## Skills

**Technical Skills:** Personal Care, Medication Administration
**Soft Skills:** Empathy
**Other Skills:** Dementia Care
"""
        out, notes = pin_skills_section_labels(tailored, "nursing")
        assert "**Care Skills:**" in out
        assert "**Technical Skills:**" not in out
        assert notes

    def test_no_change_for_tech_family(self):
        tailored = "**Technical Skills:** Python, SQL\n**Soft Skills:** Teamwork\n"
        out, notes = pin_skills_section_labels(tailored, "tech")
        assert out == tailored
        assert notes == []

    def test_no_change_when_already_correct(self):
        tailored = "**Care Skills:** Personal Care\n**Soft Skills:** Empathy\n"
        out, notes = pin_skills_section_labels(tailored, "nursing")
        assert out == tailored
        assert notes == []


# ---------------------------------------------------------------------------
# 5. Pre-composition role filter
# ---------------------------------------------------------------------------

class TestFilterIrrelevantRolesPre:

    def test_floor_prevents_overfilter(self):
        """Shanti has 3 source roles: 1 nursing (RFBI), 1 cleaning (Dimeo),
        1 other (Akala accounting). Applying for nursing → at most 1 drop
        (floor: keep 2 minimum)."""
        out, dropped = filter_irrelevant_roles_pre(SHANTI_CV, "nursing")
        # At most one dropped — floor keeps 2 entries minimum.
        assert len(dropped) <= 1

    def test_unknown_vertical_no_op(self):
        out, dropped = filter_irrelevant_roles_pre(SHANTI_CV, None)
        assert out == SHANTI_CV
        assert dropped == []

    def test_no_op_when_all_roles_match_vertical(self):
        """An all-nursing CV — no roles to drop."""
        cv = """JANE DOE

WORK EXPERIENCE

ABC Aged Care
Personal Care Worker
Jan 2024 – Jun 2024
Sydney
- Provided personal care, dementia support and medication administration.
"""
        out, dropped = filter_irrelevant_roles_pre(cv, "nursing")
        assert dropped == []


# ---------------------------------------------------------------------------
# 6. Honesty-risk assessment
# ---------------------------------------------------------------------------

class TestAssessHonestyRisk:

    def test_high_risk_low_tenure_low_ats(self):
        risk = assess_honesty_risk(SHANTI_CV, "nursing", initial_ats=39)
        assert risk["risk_level"] == "high"
        assert risk["vertical_months"] <= 3

    def test_medium_risk_low_tenure_decent_ats(self):
        risk = assess_honesty_risk(SHANTI_CV, "nursing", initial_ats=65)
        assert risk["risk_level"] == "medium"

    def test_low_risk_when_tenure_is_substantial(self):
        cv_with_2y = """SHANTI GIRI

WORK EXPERIENCE

ABC Care
Aged Care Worker
Jan 2024 – Jan 2026
Sydney, NSW
- Provided personal care, dementia support and medication administration daily.
"""
        risk = assess_honesty_risk(cv_with_2y, "nursing", initial_ats=80)
        assert risk["risk_level"] == "low"


# ---------------------------------------------------------------------------
# Smoke: SourceFacts extraction is idempotent + tolerant
# ---------------------------------------------------------------------------

class TestSourceFacts:

    def test_extracts_employers(self):
        facts = extract_source_facts(SHANTI_CV)
        names = {e.employer for e in facts.entries}
        assert any("rfbi" in n.lower() for n in names)
        assert any("akala" in n.lower() for n in names)

    def test_empty_cv(self):
        facts = extract_source_facts("")
        assert facts.entries == ()

    def test_missing_experience_section(self):
        facts = extract_source_facts("JOHN DOE\nNo work here.\n")
        assert facts.entries == ()


# ---------------------------------------------------------------------------
# 7. Credential-claim guard — strip unverifiable compliance claims from bullets
# ---------------------------------------------------------------------------

class TestEnforceCredentialClaims:

    def test_strips_pre_employment_medical_when_not_held(self):
        md = (
            "## Experience\n"
            "### The Jesmond Group\n"
            "*AIN | May 2025 – June 2026*\n\n"
            "- AIN with current compliance for pre-employment medical, police, and NDIS worker clearances.\n"
        )
        out, notes = enforce_credential_claims(md, contact_details={})
        assert "pre-employment medical" not in out.lower()
        assert "ndis" not in out.lower()
        assert "police" not in out.lower()
        assert any("pre-employment medical" in n for n in notes)

    def test_keeps_police_check_when_user_holds_it(self):
        md = "- AIN with current police clearance compliance.\n"
        out, _notes = enforce_credential_claims(
            md, contact_details={"credentials": {"police_check": True}},
        )
        # The phrase remains because the user genuinely holds the credential.
        assert "police" in out.lower()

    def test_strips_police_check_when_user_does_not_hold(self):
        md = "- AIN with current police clearance compliance in residential aged care.\n"
        out, notes = enforce_credential_claims(md, contact_details={"credentials": {}})
        assert "police clearance" not in out.lower()
        assert any("police" in n for n in notes)

    def test_leaves_non_credential_bullet_untouched(self):
        md = "- Provided personal care to elderly residents including dementia support.\n"
        out, notes = enforce_credential_claims(md, contact_details={})
        assert out == md
        assert notes == []

    def test_leaves_section_headers_untouched(self):
        md = (
            "## Professional Summary\n"
            "Compliance with NDIS worker clearance requirements is critical.\n"
        )
        out, notes = enforce_credential_claims(md, contact_details={})
        # Non-bullet line is left as-is even if it contains the phrase.
        assert "NDIS worker clearance" in out
        assert notes == []

    def test_handles_missing_contact_details(self):
        md = "- AIN with current pre-employment medical clearance.\n"
        out, notes = enforce_credential_claims(md, contact_details=None)
        assert "pre-employment medical" not in out.lower()
        assert notes
