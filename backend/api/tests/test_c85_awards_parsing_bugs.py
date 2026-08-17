"""C85 — regression tests for awards_parsing.py bugs (findings #10, #11, #12
from the C79 writers/* read-through, documented in
~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo).

  #10 — _is_valid_date's "has any digit" test misclassifies a description
        as a date. "Employee of the Year Award | Recognised for 5 years of
        dedicated service" -> the description lands in the date field (has
        a digit "5"), rendered literally as a "date".

  #11 — Award description silently vanishes when it has no recognised
        date/separator. "Staff Excellence Award | Recognised for going
        above and beyond for residents" -> the whole commentary sentence
        is discarded -- neither date nor description -- real silent data
        loss.

  #12 — Fuzzy dedup (80% token-overlap threshold) drops genuinely distinct
        award sentences that differ by one word. "...excellent teamwork
        and reliability." vs "...excellent teamwork and punctuality." ->
        the second (different trait) is silently deleted.
"""
from __future__ import annotations

from app.services.eval.writers.awards_parsing import (
    _dedupe_award_description_sentences,
    _is_valid_date,
    _parse_award_parts,
    _parse_award_raw_entry,
)


# ---------------------------------------------------------------------------
# #10 — _is_valid_date misclassifies description prose as a date
# ---------------------------------------------------------------------------


class TestIsValidDate:
    def test_description_with_a_digit_is_not_a_date(self):
        assert not _is_valid_date("Recognised for 5 years of dedicated service")

    def test_bare_year_is_a_date(self):
        assert _is_valid_date("2024")

    def test_month_year_is_a_date(self):
        assert _is_valid_date("August 2025")

    def test_year_range_is_a_date(self):
        assert _is_valid_date("2020 – 2024")

    def test_month_year_to_present_is_a_date(self):
        assert _is_valid_date("Jan 2020 – Present")

    def test_prose_mentioning_a_month_name_is_not_a_date(self):
        """Sanity for the has_month half of the original loose check —
        prose that happens to mention a month word isn't a date either."""
        assert not _is_valid_date("Nominated in May by the whole care team")

    def test_leading_day_before_month_year_is_a_date(self):
        """Round-1 review: a leading day number ('1 August 2025') is a
        common real date form the first version of this regex rejected —
        turning bug #10 (misclassified as commentary) into a silent-loss
        variant of #11 (recognised as neither date nor description)."""
        assert _is_valid_date("1 August 2025")

    def test_abbreviated_month_with_trailing_period_is_a_date(self):
        assert _is_valid_date("Aug. 2025")

    def test_to_separated_range_is_a_date(self):
        assert _is_valid_date("2020 to 2024")

    def test_abbreviated_sept_is_a_date(self):
        """Round-2 review: 'sep(?:tember)?' rejects the common 4-letter
        abbreviation 'Sept' — only 'Sep' or 'September' matched."""
        assert _is_valid_date("Sept 2025")

    def test_awards_h3_with_a_day_prefixed_date_keeps_the_date(self):
        """End-to-end: the date must actually survive through
        _parse_award_raw_entry, not just satisfy _is_valid_date in
        isolation."""
        entry_lines = [
            "### Employee of the Year Award | 1 August 2025",
        ]
        parsed = _parse_award_raw_entry(entry_lines)
        assert parsed["date"] == "1 August 2025"


def test_c10_award_h3_pipe_form_description_does_not_land_in_date_field():
    """The exact #10 repro, through the real H3 parsing path (the
    canonical writer's actual award shape)."""
    entry_lines = [
        "### Employee of the Year Award | Recognised for 5 years of dedicated service",
    ]
    parsed = _parse_award_raw_entry(entry_lines)
    assert "5 years" not in parsed["date"]
    assert "years" not in parsed["date"]


def test_c10_award_plain_form_description_does_not_land_in_date_field():
    """Same bug, through the 'plain' (no ### / no bullet marker) line
    classification path — structurally identical code to the H3 branch."""
    entry_lines = [
        "Employee of the Year Award | Recognised for 5 years of dedicated service",
    ]
    parsed = _parse_award_raw_entry(entry_lines)
    assert "5 years" not in parsed["date"]
    assert "years" not in parsed["date"]


# ---------------------------------------------------------------------------
# #11 — description silently vanishes when no date/separator is recognised
# ---------------------------------------------------------------------------


def test_c11_commentary_with_no_separator_becomes_description_not_lost():
    """The exact #11 repro — no em/en dash, no ' - ', no comma in the
    right-of-pipe segment, so the original fallback dumped it whole into
    `date`; once #10's _is_valid_date fix correctly rejects it as a date,
    the text must land in `description`, not vanish entirely."""
    name, org, date, description = _parse_award_parts(
        "Staff Excellence Award | Recognised for going above and beyond for residents"
    )
    assert "going above and beyond" in description
    assert "going above and beyond" not in date


def test_c11_genuine_dateless_separator_form_still_works():
    """Sanity: the normal 'Date – Description' separator form must still
    split correctly — this isn't a blanket change to always prefer
    description."""
    name, org, date, description = _parse_award_parts(
        "Staff Excellence Award | August 2025 – Recognised for outstanding service"
    )
    assert date == "August 2025"
    assert "outstanding service" in description


def test_c11_bare_date_with_no_description_still_lands_in_date():
    """Sanity: a pipe segment that genuinely IS just a date (no trailing
    commentary) must still be recognised as the date, not misrouted to
    description."""
    name, org, date, description = _parse_award_parts(
        "Employee of the Year Award | August 2025"
    )
    assert date == "August 2025"
    assert description == ""


def test_c11_bare_org_name_with_no_separator_lands_in_org_not_description():
    """Round-1 review: a right-of-pipe segment that's neither date-shaped
    nor commentary-shaped ('University of Sydney' — no _DESCRIPTION_PREFIX_RE
    match) is most likely a bare org name, not a description sentence.
    Routing it unconditionally to `description` (the naive #11 fix) would
    also be wrong, and inconsistent with _parse_award_raw_entry's H3/plain
    branches, which route the identical shape to `org`."""
    name, org, date, description = _parse_award_parts(
        "Dean's List | University of Sydney"
    )
    assert org == "University of Sydney"
    assert description == ""


def test_c11_location_residue_with_an_org_already_set_is_discarded_not_appended():
    """Round-2 review: when the LEFT side already supplied an org (via
    _split_award_name_org's dash split), an unclassified right-of-pipe
    segment that's pure location residue ("Sydney NSW") must be discarded
    — matching how the sibling H3/plain branches in
    _parse_award_raw_entry treat the identical shape — not appended as a
    description sentence."""
    name, org, date, description = _parse_award_parts(
        "Staff Excellence Award – Jesmond Group | Sydney NSW"
    )
    assert org == "Jesmond Group"
    assert "Sydney" not in description
    assert description == ""


# ---------------------------------------------------------------------------
# #12 — fuzzy dedup drops genuinely distinct sentences
# ---------------------------------------------------------------------------


def test_c12_distinct_trait_sentences_are_not_deduped():
    desc = (
        "Recognised for excellent teamwork and reliability. "
        "Recognised for excellent teamwork and punctuality."
    )
    out = _dedupe_award_description_sentences(desc)
    assert "reliability" in out
    assert "punctuality" in out


def test_c12_genuine_superset_sentence_still_dedupes():
    """Sanity: the ORIGINAL documented bug this function fixed (a strict
    informational subset/superset pair) must still be deduped down to the
    richer sentence — this isn't a blanket disabling of dedup."""
    desc = (
        "Recognised for hard work, caring nature, empathy and positive "
        "attitude in resident care. "
        "Recognised for hard work, caring nature, and positive attitude."
    )
    out = _dedupe_award_description_sentences(desc)
    assert out.count("Recognised for hard work") == 1
    assert "empathy" in out


def test_c12_oxford_comma_only_variant_still_dedupes():
    """Sanity: the exact-after-normalisation case (Pass 1) is untouched by
    the Pass 2 fix."""
    desc = (
        "Recognised for hard work, caring nature and positive attitude. "
        "Recognised for hard work, caring nature, and positive attitude."
    )
    out = _dedupe_award_description_sentences(desc)
    assert out.count("Recognised for hard work") == 1
