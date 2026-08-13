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


# ---------------------------------------------------------------------------
# Finding #26 (chunk C21) — bare-year date ranges ("2019 - 2023") scored
# ZERO relevant tenure because the date parser only recognised "Mon YYYY".
# ---------------------------------------------------------------------------

class TestBareYearDateRanges:
    def test_bare_year_range_parses_and_scores_nonzero_tenure(self):
        cv = """\
  WORK EXPERIENCE

General Hospital
Registered Nurse
2019 - 2023
• Provided patient care in the acute ward.

  EDUCATION

Bachelor of Nursing 2019
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].start == (2019, 1)
        assert entries[0].end == (2023, 1)
        # Jan 2019 - Jan 2023 inclusive = 49 months, not the pre-fix 0.
        assert entries[0].tenure_months() == 49

    def test_mixed_month_and_bare_year_range_parses(self):
        cv = """\
  WORK EXPERIENCE

General Hospital
Registered Nurse
Mar 2019 - 2023
• Provided patient care in the acute ward.
"""
        entries = parse_cv_experience(cv)
        assert entries[0].start == (2019, 3)
        assert entries[0].end == (2023, 1)

    def test_bare_year_to_present_parses(self):
        cv = """\
  WORK EXPERIENCE

General Hospital
Registered Nurse
2019 - Present
• Provided patient care in the acute ward.
"""
        entries = parse_cv_experience(cv)
        assert entries[0].start == (2019, 1)
        assert entries[0].end == "present"

    def test_single_bare_year_placement_parses(self):
        cv = """\
  WORK EXPERIENCE

General Hospital
Clinical Placement
2023
• Supported nursing staff with personal care tasks.
"""
        entries = parse_cv_experience(cv)
        assert entries[0].start == (2023, 1)
        assert entries[0].end == (2023, 1)
        assert entries[0].tenure_months() == 1


class TestBareYearFallbackDoesNotMisreadProseAsADate:
    """Independent review of the fix above: an earlier draft matched a bare
    year ANYWHERE in a line. Because _parse_role_date_range is used as the
    PREDICATE that finds date-anchor lines in the plaintext parser (not just
    to parse a line already known to be a date), that unanchored match let
    ordinary CV prose — a postcode, a metric, a "since <year>" bullet —
    spuriously start a new entry and steal the real entry's bullets."""

    def test_role_date_range_rejects_bare_year_in_prose(self):
        from app.services.cv.experience_parser import _parse_role_date_range

        dangerous = [
            "Sydney NSW 2000",
            "St Leonards NSW 2065",
            "• Registered with AHPRA since 2021.",
            "• Completed Certificate IV in Ageing Support in 2023.",
            "• Supported over 2000 residents across the facility.",
            "Bachelor of Business Administration Completed 2021",
            "• Reduced average wait times from 2019 to 2023.",
        ]
        for line in dangerous:
            assert _parse_role_date_range(line) is None, line

    def test_postcode_line_does_not_split_entry_or_steal_bullets(self):
        cv = """\
  CLINICAL PLACEMENT

RFBI Concord Community Village
Aged Care Placement (120 hours)
Dec 2025 – Feb 2026
Sydney NSW 2000
• Provided personal care to elderly residents including dementia care.
• Assisted with medication administration under RN supervision.
• Supported mobility assistance and activities of daily living.
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].start == (2025, 12)
        assert entries[0].end == (2026, 2)
        assert len(entries[0].bullets) == 3
        assert entries[0].primary_vertical == "nursing"

    def test_bare_year_bullet_does_not_inflate_tenure(self):
        cv = """\
  WORK EXPERIENCE

General Hospital
Registered Nurse
2019 - 2023
• Provided patient care in the acute ward.
• Registered with AHPRA since 2019.
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].tenure_months() == 49

    def test_rejects_bare_year_range_parenthesised_mid_sentence(self):
        """Round 2 of the same review: a PREFIX-only anchor check still let
        a bare-year range through when it sat inside parens/commas/colons
        mid-sentence — the text right before "2021" in this example IS a
        safe separator ("("), but real prose follows the closing paren,
        which a prefix-only check can't see. Needs the SUFFIX check too."""
        from app.services.cv.experience_parser import _parse_role_date_range

        dangerous = [
            "Awarded Employee of the Year (2021 - 2022) for ward leadership.",
            "Grew the team (2019 - 2023) from 4 to 22 people.",
            "Worked in Sydney, 2019 - 2023, across three wards.",
            "Key achievements: 2019 - 2023 revenue doubled.",
            "• Led the transformation programme - 2019 to 2023 - across sites.",
        ]
        for line in dangerous:
            assert _parse_role_date_range(line) is None, line

    def test_rejects_comma_or_colon_or_dash_before_a_bare_year(self):
        """Round 3 of the same review: the prefix guard originally treated
        ',', ':' and '-' as safe separators, same footing as '|'. Unlike
        '|' (a deliberate CV field separator that essentially never occurs
        mid-sentence), commas/colons/dashes are constant in ordinary prose
        — "Total headcount grew, 2019 - 2023." has an unsafe prefix (real
        prose before the comma) but a safe-LOOKING suffix (just a trailing
        "."), so a suffix-only check alone would wrongly accept it. Narrowed
        the safe-prefix set to '|', '(' and bullet markers only — '(' stays
        safe because the suffix check independently catches prose after the
        closing paren (see the test above)."""
        from app.services.cv.experience_parser import _parse_role_date_range

        dangerous = [
            "Total headcount grew, 2019 - 2023.",
            "Total headcount grew: 2019 - 2023.",
            "Total headcount grew - 2019 - 2023.",
        ]
        for line in dangerous:
            assert _parse_role_date_range(line) is None, line

    def test_prefix_guard_is_independently_load_bearing(self):
        """A bare-year range with an UNSAFE prefix (embedded after real
        prose, via a comma so it isn't swallowed by the month-name
        alternative first) but a SAFE-looking suffix (just a trailing
        period) — only the prefix check can reject this; a suffix-only
        design would wrongly accept it since ending in "." looks like
        end-of-sentence."""
        from app.services.cv.experience_parser import _parse_role_date_range

        assert _parse_role_date_range(
            "Total headcount grew, 2019 - 2023."
        ) is None

    def test_suffix_guard_is_independently_load_bearing(self):
        """A bare-year range with a SAFE prefix (start of line) but an
        UNSAFE suffix (real prose follows) — only the suffix check can
        reject this; a prefix-only design (round 2's own bug) wrongly
        accepts it since starting the line looks like a real date anchor."""
        from app.services.cv.experience_parser import _parse_role_date_range

        assert _parse_role_date_range(
            "2019 - 2023 was a landmark period for growth."
        ) is None

    def test_rejects_bullet_char_used_mid_line_not_as_a_leading_marker(self):
        """Round 4 of the same review: '•'/'·' were blessed as a safe
        prefix ANYWHERE they appeared, not just as a genuine leading list
        marker. A bullet line that uses '•' a second time as a decorative
        separator ("• Employee of the Year • 2021 - 2022") has "•" right
        before the year — but that's exactly the mid-sentence-prose shape
        this whole guard exists to reject. A leading marker is only safe
        when it's the ENTIRE prefix from the start of the line."""
        from app.services.cv.experience_parser import _parse_role_date_range

        dangerous = [
            "• Employee of the Year • 2021 - 2022",
            "• Led the ward roster • 2019 - 2023",
            "Registered Nurse · Employee of the Year · 2019 - 2023",
        ]
        for line in dangerous:
            assert _parse_role_date_range(line) is None, line

    def test_rejects_unclosed_paren_before_a_bare_year(self):
        """Round 4: relying on '(' for prefix safety let an UNCLOSED paren
        (a plausible pypdf column-split artifact) through, because the
        suffix regex's closing bracket was only ever OPTIONAL — an empty
        end-of-line suffix looked exactly as safe as a genuinely closed
        one. "(" now requires an actual matching ")" immediately after the
        range, not just an absent one."""
        from app.services.cv.experience_parser import _parse_role_date_range

        dangerous = [
            "• Employee of the Year (2021 - 2022",
            "• Managed the budget (2019 - 2023",
            "Grew the team (2019 - 2023",
        ]
        for line in dangerous:
            assert _parse_role_date_range(line) is None, line

    def test_mid_line_bullet_does_not_split_entry_or_steal_bullets(self):
        cv = """\
  CLINICAL PLACEMENT

RFBI Concord Community Village
Aged Care Placement (120 hours)
2019 - 2023
• Provided personal care to elderly residents including dementia care.
• Employee of the Year • 2021 - 2022
• Assisted with medication administration under RN supervision.
• Supported mobility assistance and activities of daily living.
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].start == (2019, 1)
        assert entries[0].end == (2023, 1)
        assert len(entries[0].bullets) == 4
        assert entries[0].primary_vertical == "nursing"

    def test_wrapped_postcode_after_a_date_line_does_not_split_entry(self):
        """Round 4's own independent review found a fifth leak in a
        DIFFERENT mechanism: a line that is nothing but a bare year has no
        range to anchor against, so none of the prefix/suffix guards above
        apply to it — they only guard the RANGE match path. A pypdf
        column-split can wrap an address across two lines ("Camperdown
        NSW" / "2050"), and 2000-2099 covers every Sydney metro postcode
        (this product's flagship market), so the wrapped postcode line
        then looks identical to a genuine standalone placement date.
        _parse_plaintext_section_entries (unlike _parse_role_date_range)
        can see the previous line, so it's the one place this can be
        fixed: skip a bare-year-only anchor when the previous non-empty
        line ends with an AU state abbreviation."""
        cv = """\
  WORK EXPERIENCE

Sydney Hospital
Registered Nurse
Mar 2019 - Jun 2023
Camperdown NSW
2050
• Delivered care on an acute hospital ward.
• Managed medication administration for 30 patients.
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].employer == "Sydney Hospital"
        assert entries[0].start == (2019, 3)
        assert entries[0].end == (2023, 6)
        assert len(entries[0].bullets) == 2

    def test_standalone_bare_year_placement_still_works_without_a_state_line(self):
        """The fix above must not break the deliberate feature it sits
        right next to — a standalone bare year with no preceding address
        line is still a genuine placement date."""
        cv = """\
  WORK EXPERIENCE

General Hospital
Clinical Placement
2023
• Supported nursing staff with personal care tasks.
"""
        entries = parse_cv_experience(cv)
        assert len(entries) == 1
        assert entries[0].start == (2023, 1)
        assert entries[0].end == (2023, 1)
