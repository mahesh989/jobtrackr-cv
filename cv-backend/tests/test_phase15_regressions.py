"""Phase 1.5 regressions — credential-aware verifier + award date dedupe.

These cover the exact misses observed on the post-Phase-1 Anglicare run
(claude-opus-4-7, 2026-06-03), where the verifier reported 5 keywords as
"approved but missed" even though 4 of them were present in the tailored CV
under different wording (Registration & Licences section), and where the
awards line rendered "August 2025 (August 2025)" with a duplicated date.
"""
from __future__ import annotations

from app.services.eval.writers import _format_award_entry
from app.services.pipeline.steps.tailored_rescoring import _kw_present


# ---------------------------------------------------------------------------
# Verifier — _kw_present
# ---------------------------------------------------------------------------


class TestKwPresentCredentials:
    """JD-phrased credentials should match the CV's actual wording.

    Without the credential-suffix retry the verifier reports them as missed,
    which makes the ats_lift number lie (Anglicare run reported +2 instead
    of the ~+10 the feasibility plan predicted)."""

    def test_first_aid_certificate_matches_first_aid_hltaid(self):
        cv = "Registration & Licences\n\nFirst Aid (HLTAID011) · Medication Competency"
        assert _kw_present("first aid certificate", cv.lower())

    def test_cpr_certificate_matches_bare_cpr(self):
        cv = "First Aid (HLTAID011) · CPR"
        assert _kw_present("cpr certificate", cv.lower())

    def test_drivers_licence_matches_driver_licence(self):
        # Note: stripping "license" → "drivers" doesn't help here, but the
        # suffix-strip retry should still fire and let other matchers see it.
        cv = "Driver Licence (Open) · Own a car"
        assert _kw_present("driver licence", cv.lower())  # literal match
        assert _kw_present("driver license", cv.lower())  # American spelling
        # "drivers licence" → suffix strip → "drivers" — won't match.
        # That's expected: the only reliable cure is a synonym table, which
        # is a Phase 2 concern.

    def test_conjunction_split_when_both_parts_literal(self):
        # When both literal tokens appear, conjunction split works.
        # ("covid"/"flu" ≠ "covid-19"/"influenza" — synonym-aware matching
        # is a Phase 2 concern; the verifier only handles the literal case.)
        cv = "First Aid Certificate · CPR Certificate"
        assert _kw_present("first aid and cpr certificate", cv.lower())

    def test_conjunction_requires_all_parts(self):
        # Only one part present → should NOT match.
        cv = "First Aid Certificate · Police Check"
        assert not _kw_present("first aid and cpr certificate", cv.lower())

    def test_literal_match_still_works(self):
        cv = "Skills: Personal Care, Dementia Care, Medication Administration"
        assert _kw_present("personal care", cv.lower())
        assert _kw_present("dementia care", cv.lower())
        assert not _kw_present("wound care", cv.lower())

    def test_word_boundary_not_substring(self):
        # "sql" should not match inside "mysql" without word boundaries.
        cv = "Technical: mysql, postgresql"
        assert not _kw_present("sql", cv.lower())  # word boundary protects
        assert _kw_present("mysql", cv.lower())


# ---------------------------------------------------------------------------
# Awards — _format_award_entry duplicate-date stripping
# ---------------------------------------------------------------------------


class TestAwardDateDedupe:
    """Avoid 'Jesmond Miranda Nursing Home, August 2025 (August 2025)' duplicates."""

    def test_literal_date_in_org_is_stripped(self):
        lines = _format_award_entry(
            name="Staff Excellence Award",
            org="Jesmond Miranda Nursing Home, August 2025",
            date="August 2025",
        )
        # First line is the bullet, should NOT contain the date twice.
        assert "August 2025 (August 2025)" not in lines[0]
        assert lines[0].count("August 2025") == 1
        # And the canonical shape: "* Name, Org (Date)"
        assert lines[0] == "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)"

    def test_generic_month_year_tail_stripped_even_when_dates_differ(self):
        # Org has "August 2025" but date field is "Aug 2025" — still spirit-
        # duplicate, should be deduped via the generic regex.
        lines = _format_award_entry(
            name="Award",
            org="Org Name, August 2025",
            date="Aug 2025",
        )
        assert "August 2025" not in lines[0] or "Aug 2025" in lines[0]
        assert lines[0].count("2025") == 1

    def test_org_without_trailing_date_passes_through(self):
        # No date in org → no stripping → behaviour unchanged.
        lines = _format_award_entry(
            name="Award",
            org="Jesmond Miranda Nursing Home",
            date="August 2025",
        )
        assert lines[0] == "* Award, Jesmond Miranda Nursing Home (August 2025)"

    def test_no_date_no_op(self):
        lines = _format_award_entry(name="Award", org="Org", date="")
        assert lines[0] == "* Award, Org"

    def test_date_only_no_org(self):
        lines = _format_award_entry(name="Award", org="", date="2025")
        assert lines[0] == "* Award (2025)"


# ---------------------------------------------------------------------------
# Phase 1.8 — skills tidier should not truncate generic "X Skills" entries
# ---------------------------------------------------------------------------


class TestSkillsTrailingWordTidier:
    """The skills tidier was stripping " Skills" from EVERY entry, breaking
    'Basic Computer Skills' → 'Basic Computer'. The fix: only strip when
    the base alone is a recognised competency word."""

    def setup_method(self):
        from app.services.eval.writers import _tidy_skill_qualifiers
        self.tidy = _tidy_skill_qualifiers

    def test_communication_skills_strips_to_communication(self):
        # Communication IS a real competency name → strip "Skills" suffix.
        assert self.tidy("Communication Skills") == "Communication"

    def test_interpersonal_skills_strips_to_interpersonal(self):
        assert self.tidy("Interpersonal Skills") == "Interpersonal"

    def test_basic_computer_skills_preserved(self):
        # "Basic Computer" alone reads broken — keep the "Skills" word.
        assert self.tidy("Basic Computer Skills") == "Basic Computer Skills"

    def test_computer_skills_preserved(self):
        assert self.tidy("Computer Skills") == "Computer Skills"

    def test_people_skills_preserved(self):
        assert self.tidy("People Skills") == "People Skills"

    def test_strong_leadership_skills_strips_qualifier_and_suffix(self):
        # Combined: leading qualifier ("Strong") stripped, then "Leadership
        # Skills" → "Leadership" since leadership is a competency.
        assert self.tidy("Strong Leadership Skills") == "Leadership"

    def test_strong_basic_computer_skills_strips_only_qualifier(self):
        # "Strong" stripped; "Basic Computer Skills" keeps the suffix.
        assert self.tidy("Strong Basic Computer Skills") == "Basic Computer Skills"
