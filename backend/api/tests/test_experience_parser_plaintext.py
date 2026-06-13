"""Tests for plain-text (pypdf) experience parser fallback.

Covers the common PDF-extracted CV format where sections are ALL-CAPS headings
and entries are structured as: employer line / role line / date line / bullets.
"""
import pytest
from app.services.cv.experience_parser import (
    parse_cv_experience,
    relevant_tenure_months,
    vertical_alignment_ratio,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

NURSING_PLAINTEXT_CV = """\
SHANTI GIRI

  PROFESSIONAL SUMMARY

Compassionate aged care worker with Certificate IV in Ageing Support.

  CLINICAL PLACEMENT

RFBI Concord Community Village
Aged Care Placement (120 hours)
Dec 2025 – Feb 2026
Rhodes, NSW
• Provided personal care to elderly residents including dementia care.
• Assisted with medication administration under RN supervision.
• Supported mobility assistance and activities of daily living.

  WORK EXPERIENCE

Akala Motors Private Limited
Junior Accountant
Jan 2024 – May 2025
Pokhara, Nepal
• Maintained financial records and transactions.
• Processed payroll efficiently.

  EDUCATION

Bachelor of Business Administration Completed 2021
"""

TECH_PLAINTEXT_CV = """\
JOHN SMITH

  WORK EXPERIENCE

Acme Corp
Software Engineer
Mar 2022 – Present
Sydney, NSW
• Developed REST APIs using Python and FastAPI.
• Built CI/CD pipelines with GitHub Actions.

Startup Ltd
Junior Developer
Jan 2020 – Feb 2022
• Worked on React frontend and Node.js backend.

  EDUCATION

Bachelor of Computer Science 2019
"""

MARKDOWN_CV = """\
# Jane Doe

## Experience

### General Hospital

*Registered Nurse | Jan 2023 – Present*

- Provided patient care in acute ward.
- Administered medications and wound care.

### City Clinic

*Clinical Placement | Jun 2022 – Dec 2022*

- Supported nursing staff with personal care tasks.

## Education

Bachelor of Nursing 2022
"""


# ---------------------------------------------------------------------------
# Plain-text parsing — basic structure
# ---------------------------------------------------------------------------

class TestPlaintextBasicParsing:
    def test_finds_entries_from_clinical_placement(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        assert len(entries) == 2

    def test_nursing_entry_employer(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        assert entries[0].employer == "RFBI Concord Community Village"

    def test_nursing_entry_role(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        assert "Aged Care" in entries[0].role

    def test_nursing_entry_dates(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        assert entries[0].start == (2025, 12)
        assert entries[0].end == (2026, 2)

    def test_nursing_entry_tenure_months(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        # Dec 2025 – Feb 2026 = 3 months
        assert entries[0].tenure_months() == 3

    def test_nursing_entry_bullets_extracted(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        assert len(entries[0].bullets) >= 2

    def test_non_care_entry_no_nursing_vertical(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        accountant = entries[1]
        assert accountant.primary_vertical != "nursing"


# ---------------------------------------------------------------------------
# Vertical tagging
# ---------------------------------------------------------------------------

class TestPlaintextVerticalTagging:
    def test_nursing_entry_tagged_nursing(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        assert entries[0].primary_vertical == "nursing"

    def test_tech_entry_tagged_tech(self):
        entries = parse_cv_experience(TECH_PLAINTEXT_CV)
        assert entries[0].primary_vertical == "tech"

    def test_relevant_tenure_nursing(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        months = relevant_tenure_months(entries, "nursing")
        assert months == 3  # only the aged care placement

    def test_relevant_tenure_ignores_other_verticals(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        # Accountant entry has no nursing hits — shouldn't count
        months = relevant_tenure_months(entries, "nursing")
        accounting_months = entries[1].tenure_months()
        assert months < months + accounting_months

    def test_vertical_alignment_ratio_partial(self):
        entries = parse_cv_experience(NURSING_PLAINTEXT_CV)
        ratio = vertical_alignment_ratio(entries, "nursing")
        # 1 nursing entry out of 2 total
        assert ratio == pytest.approx(0.5)

    def test_vertical_alignment_ratio_full(self):
        # CV with only nursing entries
        cv = """\
  CLINICAL PLACEMENT

Hospital A
Aged Care Worker
Jan 2025 – Jun 2025
• Provided personal care and dementia support.

Hospital B
AIN Placement
Jul 2024 – Dec 2024
• Assisted with medication administration and wound care.

  EDUCATION

Bachelor of Nursing 2024
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 2
        ratio = vertical_alignment_ratio(entries, "nursing")
        assert ratio == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Markdown path still works (regression)
# ---------------------------------------------------------------------------

class TestMarkdownPathUnchanged:
    def test_markdown_cv_parses(self):
        entries = parse_cv_experience(MARKDOWN_CV)
        assert len(entries) == 2

    def test_markdown_entry_employer(self):
        entries = parse_cv_experience(MARKDOWN_CV)
        assert entries[0].employer == "General Hospital"

    def test_markdown_entry_present_date(self):
        entries = parse_cv_experience(MARKDOWN_CV)
        assert entries[0].end == "present"

    def test_markdown_nursing_vertical(self):
        entries = parse_cv_experience(MARKDOWN_CV)
        assert entries[0].primary_vertical == "nursing"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestPlaintextEdgeCases:
    def test_empty_cv_returns_empty(self):
        assert parse_cv_experience("") == []

    def test_cv_without_experience_section_returns_empty(self):
        cv = "JOHN DOE\n\nSKILLS\nPython, SQL\n\nEDUCATION\nBSc 2020\n"
        assert parse_cv_experience(cv) == []

    def test_entry_without_dates_skipped(self):
        cv = """\
  WORK EXPERIENCE

Dimeo Cleaning
Office Cleaner
Sydney, Australia
• Cleaned offices daily.

  EDUCATION

High School 2019
"""
        entries = parse_cv_experience(cv)
        # No date range on this entry — can't score tenure, should be skipped
        assert entries == []

    def test_work_experience_header_recognised(self):
        cv = """\
  WORK EXPERIENCE

Some Hospital
Nurse Aide
Mar 2023 – Present
• Provided personal care, medication administration, and dementia support.

  EDUCATION

Cert III 2022
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].primary_vertical == "nursing"
