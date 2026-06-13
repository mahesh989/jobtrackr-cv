"""Phase 2 — Sprint B: deterministic Experience normaliser.

Two modules:
  • sort_experience_chronologically — reverse-chronological order, ongoing
    roles first then ended.
  • normalise_experience_tense — first verb of every bullet matches the
    role's date status (Present → present tense; ended → past tense).

Source bug: GPT-5.1 Anglicare run had Jesmond (May 2025) listed BEFORE
Uniting (Mar 2026) — wrong order. A later run got the order right but had
one past-tense bullet ("Transported residents...") in an otherwise
present-tense Present role.
"""
from __future__ import annotations

from app.services.eval.writers import (
    sort_experience_chronologically,
    normalise_experience_tense,
    _parse_role_date_range,
    _parse_month_year,
    _convert_bullet_tense,
)


# ---------------------------------------------------------------------------
# Date parser
# ---------------------------------------------------------------------------


class TestDateParser:
    def test_parse_mar_2026(self):
        assert _parse_month_year("Mar 2026") == (2026, 3)

    def test_parse_sept_2024(self):
        assert _parse_month_year("Sept 2024") == (2024, 9)

    def test_parse_sept_20_2024(self):
        # Day-of-month variant — must extract just (year, month).
        assert _parse_month_year("Sept 20, 2024") == (2024, 9)

    def test_parse_june_2022(self):
        assert _parse_month_year("June 2022") == (2022, 6)

    def test_unparseable_returns_none(self):
        assert _parse_month_year("not a date") is None
        assert _parse_month_year("") is None

    def test_range_with_present(self):
        r = _parse_role_date_range("*Care Worker | Mar 2026 – Present*")
        assert r == ((2026, 3), "present")

    def test_range_with_two_dates(self):
        r = _parse_role_date_range("*Bachelor | Sept 2019 – June 2022*")
        assert r == ((2019, 9), (2022, 6))

    def test_single_date_placement(self):
        r = _parse_role_date_range("*Placement | Sept 2024*")
        assert r == ((2024, 9), (2024, 9))


# ---------------------------------------------------------------------------
# Chronological sort — the Anglicare-shape regression
# ---------------------------------------------------------------------------


_ANGLICARE_MD = """
## Experience

### Jesmond Miranda Nursing Home | Miranda, NSW

*Assistant in Nursing (Casual) | May 2025 – Present*

- Serve as primary Medication Assistant, managing electronic medication.
- Deliver comprehensive personal care.

### Uniting – The Marion | Leichhardt, NSW

*Care Worker (Casual) | Mar 2026 – Present*

- Provide person-centred care to residents.
- Monitor and report changes.

### Anglicare Mildred Symons House | Jannali, NSW

*Aged Care Placement (120 Hours) | Sept 2024*

- Delivered specialised dementia care.

## Education

Some education
""".lstrip()


class TestChronologicalSort:
    """The exact bug: Mar 2026 should appear BEFORE May 2025 (both Present)."""

    def test_anglicare_ongoing_by_start_desc(self):
        out = sort_experience_chronologically(_ANGLICARE_MD)
        # Uniting (Mar 2026) must come BEFORE Jesmond (May 2025).
        uniting_pos = out.index("Uniting")
        jesmond_pos = out.index("Jesmond")
        anglicare_pos = out.index("Mildred Symons")
        assert uniting_pos < jesmond_pos
        assert jesmond_pos < anglicare_pos

    def test_idempotent(self):
        once = sort_experience_chronologically(_ANGLICARE_MD)
        twice = sort_experience_chronologically(once)
        assert once == twice

    def test_two_ended_roles_by_end_desc(self):
        md = """
## Experience

### Old Co | NSW

*Engineer | Jan 2018 – Dec 2019*

- Built things.

### Newer Co | NSW

*Senior Engineer | Jan 2020 – Dec 2022*

- Built better things.
""".lstrip()
        out = sort_experience_chronologically(md)
        newer = out.index("Newer Co")
        old = out.index("Old Co")
        assert newer < old

    def test_present_role_beats_recent_ended(self):
        # Even when an ended role's end date is more recent (in absolute terms),
        # ongoing roles sort first by convention. Common case: someone left a
        # job last month and is between roles; the still-active role they got
        # since must appear first.
        md = """
## Experience

### Ended Co | NSW

*Manager | Jan 2024 – Apr 2026*

- Did things.

### Ongoing Co | NSW

*Worker | Feb 2026 – Present*

- Doing things.
""".lstrip()
        out = sort_experience_chronologically(md)
        ongoing = out.index("Ongoing Co")
        ended = out.index("Ended Co")
        assert ongoing < ended

    def test_single_entry_noop(self):
        md = """
## Experience

### Only Co | NSW

*Worker | Jan 2024 – Present*

- A bullet.

## Education
""".lstrip()
        out = sort_experience_chronologically(md)
        assert out == md

    def test_no_experience_section_noop(self):
        md = "## Skills\n\nPersonal Care, Dementia Care\n"
        assert sort_experience_chronologically(md) == md


# ---------------------------------------------------------------------------
# Tense normaliser
# ---------------------------------------------------------------------------


class TestBulletTenseConverter:
    def test_past_to_present(self):
        out = _convert_bullet_tense("- Transported residents to appointments.", want_present=True)
        assert out == "- Transport residents to appointments."

    def test_present_to_past(self):
        out = _convert_bullet_tense("- Transport residents to appointments.", want_present=False)
        assert out == "- Transported residents to appointments."

    def test_no_change_when_already_correct(self):
        bullet = "- Provide person-centred care."
        assert _convert_bullet_tense(bullet, want_present=True) == bullet

    def test_unknown_verb_unchanged(self):
        # "Frobnicated" isn't in the verb table — leave it alone.
        bullet = "- Frobnicated the system extensively."
        assert _convert_bullet_tense(bullet, want_present=True) == bullet

    def test_non_bullet_unchanged(self):
        # A free-floating paragraph line isn't a bullet.
        line = "Provided extensive support."
        assert _convert_bullet_tense(line, want_present=True) == line

    def test_irregular_past_to_present_led(self):
        # "Led" → "Lead"
        out = _convert_bullet_tense("- Led a team of 5.", want_present=True)
        assert out == "- Lead a team of 5."

    def test_irregular_present_to_past_lead(self):
        out = _convert_bullet_tense("- Lead a team of 5.", want_present=False)
        assert out == "- Led a team of 5."


class TestExperienceTenseNormaliser:
    """The exact regression from GPT-5.1's Anglicare run: one past-tense bullet
    in an otherwise present-tense Present role."""

    def test_transported_in_present_role_becomes_transport(self):
        md = """
## Experience

### Jesmond | NSW

*Assistant in Nursing | May 2025 – Present*

- Serve as primary Medication Assistant.
- Deliver personal care.
- Transported residents to appointments.
""".lstrip()
        out = normalise_experience_tense(md)
        # All three bullets must use present tense.
        assert "- Transport residents" in out
        assert "- Transported" not in out
        assert "- Serve as primary" in out
        assert "- Deliver personal care" in out

    def test_present_verbs_in_ended_role_become_past(self):
        md = """
## Experience

### Old Co | NSW

*Manager | Jan 2018 – Dec 2019*

- Deliver weekly reports.
- Provide guidance to team.
""".lstrip()
        out = normalise_experience_tense(md)
        assert "- Delivered weekly reports" in out
        assert "- Provided guidance" in out

    def test_placement_uses_past_tense(self):
        # Single-date placement (e.g. "Sept 2024") is treated as completed.
        md = """
## Experience

### Anglicare Mildred Symons House | NSW

*Aged Care Placement | Sept 2024*

- Deliver dementia care.
""".lstrip()
        out = normalise_experience_tense(md)
        assert "- Delivered dementia care" in out

    def test_idempotent(self):
        md = """
## Experience

### Jesmond | NSW

*Assistant in Nursing | May 2025 – Present*

- Transported residents.
""".lstrip()
        once = normalise_experience_tense(md)
        twice = normalise_experience_tense(once)
        assert once == twice

    def test_no_experience_section_noop(self):
        md = "## Skills\n\nPersonal Care\n"
        assert normalise_experience_tense(md) == md
