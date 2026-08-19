"""C22b (from C22's round-1/round-2 review): pdf_generator/parsing.py's
_parse_markdown extracts a "## Heading" line's title via `stripped[3:].strip()`
with no trailing-colon stripping — unlike contact_line.py, awards.py, and
enforce_w8.py, which all normalise a heading key via `.rstrip(":")` before
comparing it against a lookup table.

_SECTION_ALIASES.get(title.lower()) (sections.py) is an EXACT match against
colon-free keys, so a heading the AI writer emits WITH a trailing colon
("## Registration & Licences:") defeats every alias in _SECTION_ALIASES —
not just C22's new role-pack entries, but every existing alias too — and
also defeats _relabel_registration's own exact-match heading lookup
(enforce_w8.py:275). The section falls into "extras" and renders dead last,
finding #25 verbatim, via a different trigger than C22 fixed (C22 fixed the
alias MAP's coverage; this is the heading EXTRACTION itself failing to
normalise before the map is even consulted).

Confirmed NOT purely theoretical by C22's own review: this bites whenever
the AI emits the colon AND the user has no saved credentials to trigger
stamp_credentials' .rstrip(":") normalisation elsewhere in the pipeline —
i.e. this parsing-layer bug is the only remaining defence for that case.
"""
from __future__ import annotations

from app.services.cv.pdf_generator.parsing import _SECTION_ALIASES, _parse_markdown


def _first_section_title(markdown: str) -> str:
    _name, _contact, sections = _parse_markdown(markdown)
    assert sections, f"expected at least one section, got none for: {markdown!r}"
    return sections[0][0]


class TestParseMarkdownStripsTrailingColonFromHeadings:
    def test_REGRESSION_registration_and_licences_with_trailing_colon(self):
        md = "## Registration & Licences:\n- AHPRA registered nurse\n"
        title = _first_section_title(md)
        assert title == "Registration & Licences"
        assert _SECTION_ALIASES.get(title.lower()) is not None

    def test_REGRESSION_existing_alias_also_defeated_by_a_trailing_colon(self):
        # Not just C22's new role-pack entries — EVERY _SECTION_ALIASES key
        # was defeated by this, since the extraction itself never stripped
        # the colon before any lookup ran.
        md = "## Professional Experience:\n### Org A\n- Did things\n"
        title = _first_section_title(md)
        assert title == "Professional Experience"
        assert _SECTION_ALIASES.get(title.lower()) == "experience"

    def test_heading_without_a_trailing_colon_is_unaffected(self):
        md = "## Skills\n- Python\n"
        assert _first_section_title(md) == "Skills"

    def test_only_a_single_trailing_colon_is_stripped_not_colons_mid_heading(self):
        # A colon that's genuinely part of the heading text (unusual, but
        # must not be mistaken for the AI's trailing-punctuation habit)
        # stays if it's not the LAST character.
        md = "## Skills: A Summary\n- Python\n"
        assert _first_section_title(md) == "Skills: A Summary"
