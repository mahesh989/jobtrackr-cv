"""Coverage gap (audit, execution chunk C42a): tailored_structural_validation/
parsing.py — the markdown section splitter and entry parser every one of the
package's 17 gates depends on — had zero direct test coverage. A parsing bug
here silently corrupts every downstream gate's input, which is why this is
the highest-priority sub-chunk of C42's split (see C42's own investigation
for the full 6-way PR split rationale).

Split out of the former single-module tailored_structural_validation.py —
these tests exercise the split-out functions directly, not just as a side
effect of a full run_tailored_structural_validation() call (test_relevance.py
already does that for 2 of the 17 gates, but never asserts on parsing.py's
own output shape).
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation.parsing import (
    _split_sections,
    _resolve_section,
    _parse_entries,
    _word_count,
    _parse_two_line_blocks,
    _check_two_line_shape,
    _PROFILE_ALIASES,
    _EXPERIENCE_ALIASES,
)


# ---------------------------------------------------------------------------
# _split_sections
# ---------------------------------------------------------------------------


class TestSplitSections:
    def test_splits_multiple_level_2_headings(self):
        md = "## Experience\nDid things.\n\n## Education\nBachelor of Science\n"
        sections = _split_sections(md)
        assert sections["experience"] == "Did things."
        assert sections["education"] == "Bachelor of Science"

    def test_text_before_first_heading_is_preamble(self):
        md = "Jane Doe\njane@example.com\n\n## Experience\nDid things.\n"
        sections = _split_sections(md)
        assert "Jane Doe" in sections["_preamble"]
        assert sections["experience"] == "Did things."

    def test_heading_names_are_lowercased(self):
        md = "## EXPERIENCE\nDid things.\n"
        sections = _split_sections(md)
        assert "experience" in sections
        assert "EXPERIENCE" not in sections

    def test_heading_names_are_whitespace_trimmed(self):
        md = "##   Experience   \nDid things.\n"
        sections = _split_sections(md)
        assert "experience" in sections

    def test_h3_headings_do_not_start_a_new_section(self):
        md = "## Experience\n### General Hospital\nDid things.\n"
        sections = _split_sections(md)
        assert "### general hospital" not in sections
        assert "### General Hospital" in sections["experience"]

    def test_empty_input_yields_only_preamble(self):
        sections = _split_sections("")
        assert sections == {"_preamble": ""}

    def test_body_is_stripped_of_leading_trailing_whitespace(self):
        md = "## Experience\n\n\n  Did things.  \n\n\n"
        sections = _split_sections(md)
        assert sections["experience"] == "Did things."

    def test_last_section_body_is_captured(self):
        # Regression-shape guard: the loop only flushes on the NEXT heading,
        # so the final section's body must still be captured after the loop.
        md = "## Skills\n- Python\n- SQL"
        sections = _split_sections(md)
        assert "Python" in sections["skills"]
        assert "SQL" in sections["skills"]


# ---------------------------------------------------------------------------
# _resolve_section
# ---------------------------------------------------------------------------


class TestResolveSection:
    def test_returns_body_of_the_first_matching_alias(self):
        sections = {"summary": "A summary.", "highlights": "Highlights text."}
        assert _resolve_section(sections, _PROFILE_ALIASES) == "Highlights text."

    def test_first_alias_in_tuple_order_wins_not_first_in_dict(self):
        # _PROFILE_ALIASES starts with "career highlights", then "highlights".
        sections = {"highlights": "B", "career highlights": "A"}
        assert _resolve_section(sections, _PROFILE_ALIASES) == "A"

    def test_returns_empty_string_when_no_alias_present(self):
        sections = {"education": "Bachelor of Science"}
        assert _resolve_section(sections, _EXPERIENCE_ALIASES) == ""


# ---------------------------------------------------------------------------
# _parse_entries
# ---------------------------------------------------------------------------


class TestParseEntries:
    def test_single_entry_with_bullets(self):
        body = (
            "### General Hospital\n"
            "*Registered Nurse | Jan 2023 – Present*\n"
            "- Provided patient care.\n"
            "- Administered medications.\n"
        )
        entries = _parse_entries(body)
        assert len(entries) == 1
        assert entries[0]["title_line"] == "### General Hospital"
        assert entries[0]["bullets"] == [
            "Provided patient care.",
            "Administered medications.",
        ]

    def test_italic_subtitle_line_is_absorbed_not_a_new_entry(self):
        body = "### General Hospital\n*Registered Nurse | Jan 2023 – Present*\n- Did care.\n"
        entries = _parse_entries(body)
        assert len(entries) == 1

    def test_multiple_entries_split_on_title_lines(self):
        body = (
            "### General Hospital\n"
            "- Did care.\n"
            "### City Clinic\n"
            "- Supported staff.\n"
        )
        entries = _parse_entries(body)
        assert len(entries) == 2
        assert entries[0]["title_line"] == "### General Hospital"
        assert entries[1]["title_line"] == "### City Clinic"

    def test_orphan_bullet_with_no_preceding_title_is_ignored(self):
        body = "- Orphan bullet with no title above it.\n### General Hospital\n- Real bullet.\n"
        entries = _parse_entries(body)
        assert len(entries) == 1
        assert entries[0]["bullets"] == ["Real bullet."]

    def test_empty_body_yields_no_entries(self):
        assert _parse_entries("") == []

    def test_blank_lines_are_skipped(self):
        body = "### General Hospital\n\n\n- Did care.\n\n"
        entries = _parse_entries(body)
        assert len(entries) == 1
        assert entries[0]["bullets"] == ["Did care."]

    def test_bullet_markers_dash_bullet_and_asterisk_all_recognised(self):
        body = "### Title\n- Dash bullet.\n• Bullet-char bullet.\n* Asterisk bullet.\n"
        entries = _parse_entries(body)
        assert entries[0]["bullets"] == [
            "Dash bullet.",
            "Bullet-char bullet.",
            "Asterisk bullet.",
        ]

    def test_entry_with_no_bullets_still_captured(self):
        body = "### Title Only\n### Second Title\n- Has a bullet.\n"
        entries = _parse_entries(body)
        assert len(entries) == 2
        assert entries[0]["bullets"] == []

    def test_KNOWN_EDGE_CASE_asterisk_subtitle_with_a_leading_space_is_misparsed_as_a_bullet(self):
        # Characterizes actual current behaviour (C42a scoping investigation
        # flagged this boundary): subtitle_re requires the line to be a
        # SINGLE italic span with no leading space after the opening "*".
        # bullet_re is checked FIRST and matches "* " (asterisk + any
        # whitespace) as a bullet marker regardless of what follows. So
        # "* Title | Dates *" — a subtitle line with a stray leading space
        # after the asterisk — is misparsed as a bullet, with the trailing
        # "*" left dangling in the bullet text, rather than being absorbed
        # as the entry's subtitle. This pins the CURRENT behavior; whether
        # it's desirable is a separate question (see C42's own scoping
        # notes) — not addressed here, this is a coverage-only chunk.
        body = "### General Hospital\n* Registered Nurse | Jan 2023 *\n- Did care.\n"
        entries = _parse_entries(body)
        assert len(entries) == 1
        assert entries[0]["bullets"][0] == "Registered Nurse | Jan 2023 *"


# ---------------------------------------------------------------------------
# _word_count
# ---------------------------------------------------------------------------


class TestWordCount:
    def test_counts_whitespace_separated_tokens(self):
        assert _word_count("one two three") == 3

    def test_empty_string_is_zero(self):
        assert _word_count("") == 0

    def test_none_is_zero(self):
        assert _word_count(None) == 0

    def test_multiple_spaces_collapse_to_one_gap(self):
        assert _word_count("one   two") == 2

    def test_newlines_count_as_separators(self):
        assert _word_count("one\ntwo\nthree") == 3


# ---------------------------------------------------------------------------
# _parse_two_line_blocks
# ---------------------------------------------------------------------------


class TestParseTwoLineBlocks:
    def test_h3_title_with_italic_subline(self):
        body = "### Big University | City\n*Bachelor of Science | 2018 – 2022*\n"
        blocks = _parse_two_line_blocks(body)
        assert len(blocks) == 1
        assert blocks[0]["has_subline"] is True
        assert blocks[0]["subline"] == "*Bachelor of Science | 2018 – 2022*"

    def test_bold_only_title_variant_recognised(self):
        body = "**Big University | City**\n*Bachelor of Science | 2018 – 2022*\n"
        blocks = _parse_two_line_blocks(body)
        assert len(blocks) == 1
        assert blocks[0]["has_subline"] is True

    def test_title_with_no_subline(self):
        body = "### Big University | City\nSome plain paragraph, not italic.\n"
        blocks = _parse_two_line_blocks(body)
        assert len(blocks) == 1
        assert blocks[0]["has_subline"] is False
        assert blocks[0]["subline"] == ""

    def test_blank_lines_between_title_and_subline_are_skipped_over(self):
        body = "### Big University\n\n\n*Bachelor of Science | 2022*\n"
        blocks = _parse_two_line_blocks(body)
        assert blocks[0]["has_subline"] is True

    def test_title_at_end_of_body_with_nothing_after_it(self):
        body = "### Big University\n"
        blocks = _parse_two_line_blocks(body)
        assert len(blocks) == 1
        assert blocks[0]["has_subline"] is False

    def test_multiple_blocks_parsed_independently(self):
        body = (
            "### Uni A\n*BSc | 2020*\n"
            "### Uni B\nplain line, no subline\n"
        )
        blocks = _parse_two_line_blocks(body)
        assert len(blocks) == 2
        assert blocks[0]["has_subline"] is True
        assert blocks[1]["has_subline"] is False

    def test_empty_body_yields_no_blocks(self):
        assert _parse_two_line_blocks("") == []


# ---------------------------------------------------------------------------
# _check_two_line_shape
# ---------------------------------------------------------------------------


class TestCheckTwoLineShape:
    def test_no_blocks_passes_with_nothing_to_check_message(self):
        result = _check_two_line_shape([], "gate_x", "Education")
        assert result["status"] == "pass"
        assert "No Education entries" in result["detail"]

    def test_all_blocks_with_subline_passes(self):
        blocks = [
            {"title_line": "### A", "subline": "*x*", "has_subline": True},
            {"title_line": "### B", "subline": "*y*", "has_subline": True},
        ]
        result = _check_two_line_shape(blocks, "gate_x", "Education")
        assert result["status"] == "pass"

    def test_all_blocks_missing_subline_fails(self):
        blocks = [
            {"title_line": "### A", "subline": "", "has_subline": False},
            {"title_line": "### B", "subline": "", "has_subline": False},
        ]
        result = _check_two_line_shape(blocks, "gate_x", "Education")
        assert result["status"] == "fail"
        assert "None of the 2 Education entries" in result["detail"]

    def test_mixed_blocks_fails_with_inconsistent_message(self):
        blocks = [
            {"title_line": "### A", "subline": "*x*", "has_subline": True},
            {"title_line": "### B", "subline": "", "has_subline": False},
        ]
        result = _check_two_line_shape(blocks, "gate_x", "Education")
        assert result["status"] == "fail"
        assert "inconsistent" in result["detail"]
        assert "1 of 2" in result["detail"]

    def test_gate_name_is_passed_through_to_the_result(self):
        result = _check_two_line_shape([], "my_gate_name", "Projects")
        assert result["name"] == "my_gate_name"

    def test_missing_entry_titles_are_truncated_and_cleaned_in_the_message(self):
        long_title = "### " + ("x" * 100)
        blocks = [{"title_line": long_title, "subline": "", "has_subline": False}]
        result = _check_two_line_shape(blocks, "gate_x", "Projects")
        # _short truncates to 60 chars; the "###"/"*" markup is stripped.
        assert "###" not in result["detail"].split(":", 1)[1]
        assert "…" in result["detail"]
