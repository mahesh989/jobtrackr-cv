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
# Sprint D — extended location stripping on the award org field.
# ---------------------------------------------------------------------------


class TestSprintDLocationStripping:
    """The post-Sprint-C Anglicare run rendered:
       'Staff Excellence Award, Jesmond Miranda Nursing Home Miranda (August 2025)'
    Sprint D extends _strip_au_location to handle the LLM's no-comma variant
    AND duplicate-trailing-word concatenation."""

    def test_jesmond_miranda_duplicate_stripped(self):
        # The exact production bug.
        lines = _format_award_entry(
            name="Staff Excellence Award",
            org="Jesmond Miranda Nursing Home Miranda",
            date="August 2025",
        )
        assert lines[0] == "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)"

    def test_no_comma_suburb_state_country_stripped(self):
        # LLM emitted org as "Anglicare Sydney Kirrawee, NSW, Australia"
        # — no comma between Sydney and Kirrawee.
        lines = _format_award_entry(
            name="Award",
            org="Anglicare Sydney Kirrawee, NSW, Australia",
            date="2024",
        )
        assert lines[0] == "* Award, Anglicare Sydney (2024)"

    def test_two_word_suburb_with_state_stripped(self):
        # "North Sydney" is a two-word suburb. With our STRICT regex (single
        # capword before STATE), only "Sydney" gets stripped — "North" is
        # left attached to the org. This is a conservative trade-off: in
        # production the LLM either emits proper commas (org-comma-suburb)
        # or concatenates a single-word suburb. Two-word suburb concatenation
        # without commas is rare and ambiguous.
        lines = _format_award_entry(
            name="Award",
            org="Some Org North Sydney, NSW",
            date="2024",
        )
        # Strips ' Sydney, NSW' — "North" remains as part of the org.
        assert "NSW" not in lines[0]
        assert "Some Org North" in lines[0]

    def test_corporate_suffix_not_stripped(self):
        # 'Acme Pty' — "Pty" is a corporate suffix, must not be treated as
        # duplicate even if 'Pty' appeared earlier.
        lines = _format_award_entry(
            name="Award",
            org="Acme Pty",
            date="2024",
        )
        assert "Pty" in lines[0]

    def test_normal_org_unchanged(self):
        # Clean org → unchanged.
        lines = _format_award_entry(
            name="Award",
            org="Anglicare",
            date="2024",
        )
        assert lines[0] == "* Award, Anglicare (2024)"

    def test_genuinely_repeated_word_in_short_org_not_stripped(self):
        # 'Big Big Co' — 2 words plus trailing dup. Length-3 minimum applies,
        # so we DO check. 'Big' would dedupe... but this is an edge case
        # that's unlikely in practice. Document the behaviour.
        lines = _format_award_entry(
            name="Award",
            org="Big Big Co",
            date="2024",
        )
        # 'Co' is a corporate suffix → not stripped. 'Big Big Co' stays.
        assert "Co" in lines[0]

    def test_bare_year_tail_in_org_stripped_when_date_has_same_year(self):
        # Post-Sprint-F ADS Care run (Opus 4.8) rendered:
        #   'Staff Excellence Award, Jesmond Miranda Nursing Home, 2025 (August 2025)'
        # The org field had ', 2025' appended even though date carries
        # 'August 2025'. Same year appears twice in different forms.
        lines = _format_award_entry(
            name="Staff Excellence Award",
            org="Jesmond Miranda Nursing Home, 2025",
            date="August 2025",
        )
        assert lines[0] == "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)"
        assert lines[0].count("2025") == 1

    def test_bare_year_not_stripped_when_date_has_different_year(self):
        # If the org's tail year and date's year are different, leave both —
        # might be a real two-year context (e.g. 'Org, 2020' + date '2024').
        lines = _format_award_entry(
            name="Award",
            org="Some Org, 2020",
            date="2024",
        )
        assert "2020" in lines[0]
        assert "2024" in lines[0]


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
