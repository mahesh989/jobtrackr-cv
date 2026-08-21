"""Career-highlights word-floor helpers.

Regression cover for the bug where a 31-word Professional Summary reached
production despite the composer prompt declaring 35 words a HARD MINIMUM.

Two independent defects combined:

  1. _career_highlights_word_count / _replace_career_highlights_prose looked
     for the literal heading "## Career Highlights". restore_and_order()
     renames that heading to the role family's own name partway through the
     pipeline (nursing → "## Professional Summary"), so both helpers went
     blind for exactly the families that use a different display name — the
     floor check silently measured "0 words" and returned early.

  2. The floor check only ever ran BEFORE verify_claims. verify_claims is an
     AI step that STRIPS unentailed clauses, so it structurally shrinks the
     summary; nothing re-measured afterwards.

These tests pin the helper-level behaviour (1). The post-verify re-run (2)
is wired in writers/_impl.py's _writer_w8_verified.
"""
from __future__ import annotations

from app.services.eval.writers.career_highlights import (
    _CAREER_HIGHLIGHTS_FLOOR,
    _career_highlights_word_count,
    _replace_career_highlights_prose,
)

_PROSE = "Assistant in Nursing with experience in residential aged care."  # 9 words


def _md(heading: str, *, availability: bool = False) -> str:
    avail = "\n*Available: Full Time, Part Time*\n" if availability else ""
    return f"## {heading}\n\n{_PROSE}\n{avail}\n## Skills\n- **Core Skills:** Personal Care\n"


class TestWordCountIsHeadingAgnostic:
    def test_counts_under_every_summary_heading_alias(self):
        # nursing renders "Professional Summary"; the canonical mid-pipeline
        # name is "Career Highlights"; "Summary" is the manual family's.
        for heading in ("Career Highlights", "Professional Summary", "Summary"):
            n, prose = _career_highlights_word_count(_md(heading))
            assert n == 9, f"{heading!r} measured {n} words"
            assert prose == _PROSE

    def test_availability_line_is_not_counted_as_prose(self):
        # The stamped italic "*Available: …*" note lives inside the summary
        # block. Counting it would inflate the total and mask a short summary.
        n, _ = _career_highlights_word_count(_md("Professional Summary", availability=True))
        assert n == 9

    def test_missing_summary_returns_zero(self):
        assert _career_highlights_word_count("## Skills\n- x\n") == (0, "")


class TestProseReplacementPreservesBlockExtras:
    def test_replaces_prose_under_a_renamed_heading(self):
        out = _replace_career_highlights_prose(
            _md("Professional Summary"), "A much longer rewritten summary sentence."
        )
        assert "A much longer rewritten summary sentence." in out
        assert _PROSE not in out
        assert "## Professional Summary" in out  # heading itself untouched

    def test_availability_line_survives_replacement(self):
        # Regression: the old implementation rebuilt the block as
        # [heading, "", prose, ""], discarding every other line — harmless
        # pre-verify (availability is stamped later) but it would silently
        # delete the note on the post-verify re-run.
        out = _replace_career_highlights_prose(
            _md("Professional Summary", availability=True), "Rewritten prose."
        )
        assert "*Available: Full Time, Part Time*" in out
        assert "Rewritten prose." in out
        assert _PROSE not in out

    def test_following_section_is_not_clobbered(self):
        out = _replace_career_highlights_prose(_md("Summary"), "Rewritten prose.")
        assert "## Skills" in out
        assert "- **Core Skills:** Personal Care" in out


def test_floor_constant_matches_the_prompt_contract():
    # composition.py states "35 is a HARD MINIMUM" for the summary; if that
    # prompt number moves, this constant must move with it.
    assert _CAREER_HIGHLIGHTS_FLOOR == 35
