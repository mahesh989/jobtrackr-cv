"""C22b (from C22's original finding, closed for pdf_generator/parsing.py by
test_pdf_heading_trailing_colon.py): eval/enforce_w8.py has FOUR independent
copies of the same "extract a '## Heading' name via ln[3:].strip()" pattern
(or the whole-line equivalent, `l.strip().lower() == "## education"`), none
stripping a trailing colon:

  1. `_reorder_sections`'s own inline block-splitter — feeds `name == want`
     against `section_order`; an unstripped colon drops a section out of its
     intended position into the unordered append-at-end bucket.
  2. `_split_blocks` (used by `_relabel_registration` and others) — feeds
     `name == "Registration & Licences"`; a colon means an unregistered care
     worker's section never gets relabeled to "Checks & Clearances" — the
     same "Checks & Clearances" duplicate-section bug #57/C23 fixed for a
     different trigger (a relabel that already happened), reopened here for
     "the relabel itself never ran".
  3. `_rename_headings` (feeds `to_canonical`) — THE HIGHEST-IMPACT site,
     found in an independent review of sites 1-2: a colon'd heading skips
     the rename to canonical names entirely, which means it ALSO skips the
     entire frozen production contract those canonical names feed
     (structure.py's role/bullet caps, summary.py's word-count enforcement)
     — not just a display-ordering miss like sites 1-2.
  4. `ensure_bachelor`'s Education-heading finder — a colon'd "## Education:"
     silently no-ops the whole Bachelor-degree-recovery pass.

Found via two rounds of independent review, each catching the next site:
round 1 (reviewing the pdf_generator/parsing.py fix) caught that a code
comment falsely claimed enforce_w8.py already used .rstrip(":") as
precedent (verified false — 0 matches) and found sites 1-2; round 2
(reviewing the sites 1-2 fix) found sites 3-4 while checking "any other copy
of this pattern in the file".
"""
from __future__ import annotations

from app.services.eval.enforce_w8 import (
    _relabel_registration,
    _rename_headings,
    _split_blocks,
    ensure_bachelor,
    to_canonical,
)
from app.services.verticals.nursing.config import PROFILE as NURSING_PROFILE


class TestSplitBlocksStripsTrailingColonFromHeadingNames:
    def test_REGRESSION_heading_name_has_no_trailing_colon(self):
        md = "## Registration & Licences:\n\nAHPRA registered nurse\n"
        _preamble, blocks = _split_blocks(md)
        assert blocks[0][0] == "Registration & Licences"

    def test_raw_heading_line_is_unchanged_only_the_comparison_name_is_normalised(self):
        # blk[0] (the actual re-serialized line) must still carry the colon
        # verbatim — only the extracted `name` used for comparisons changes.
        md = "## Registration & Licences:\n\nAHPRA registered nurse\n"
        _preamble, blocks = _split_blocks(md)
        _name, block_lines = blocks[0]
        assert block_lines[0] == "## Registration & Licences:"


class TestRelabelRegistrationRecognisesATrailingColonHeading:
    def test_REGRESSION_relabels_to_checks_and_clearances_despite_the_colon(self):
        # An unregistered care worker (clearances only, no AHPRA/RN/EN token)
        # — the section must be relabeled "Checks & Clearances", the same
        # outcome as the colon-free heading already covered elsewhere.
        md = (
            "# Name\n\nContact\n\n"
            "## Registration & Licences:\n"
            "- National Police Check\n"
            "- Working with Children Check\n\n"
            "## Experience\n- Did things.\n"
        )
        out = _relabel_registration(md, NURSING_PROFILE)
        assert "## Checks & Clearances" in out
        assert "## Registration & Licences" not in out

    def test_a_genuine_registration_keeps_the_heading_despite_the_colon(self):
        md = (
            "# Name\n\nContact\n\n"
            "## Registration & Licences:\n"
            "- AHPRA registered nurse (RN)\n\n"
            "## Experience\n- Did things.\n"
        )
        out = _relabel_registration(md, NURSING_PROFILE)
        assert "## Registration & Licences" in out
        assert "## Checks & Clearances" not in out

    def test_non_nursing_family_is_a_no_op(self):
        from app.services.verticals import _GENERAL_PROFILE

        md = "## Registration & Licences:\n- Something\n"
        assert _relabel_registration(md, _GENERAL_PROFILE) == md


class TestRenameHeadingsToCanonicalRecognisesATrailingColonHeading:
    """_rename_headings (via to_canonical) — the highest-impact site: skipping
    this rename means skipping the frozen production contract entirely for
    that section, not just a display-ordering miss."""

    def test_REGRESSION_summary_heading_with_trailing_colon_still_renames_to_canonical(self):
        md = "## Professional Summary:\n\nExperienced nurse.\n\n## Experience\n- Did things.\n"
        out = to_canonical(md, NURSING_PROFILE)
        assert "## Career Highlights" in out
        assert "## Professional Summary" not in out

    def test_REGRESSION_experience_heading_with_trailing_colon_still_renames_to_canonical(self):
        md = "## Professional Summary\n\nExperienced nurse.\n\n## Experience:\n- Did things.\n"
        out = to_canonical(md, NURSING_PROFILE)
        assert "## Professional Experience\n- Did things." in out
        assert "## Experience:" not in out

    def test_heading_not_in_the_mapping_is_left_untouched_colon_and_all(self):
        # A heading the production contract has no opinion on (e.g.
        # "Registration & Licences") must pass through verbatim, colon
        # included — _rename_headings only touches keys present in `mapping`.
        md = "## Registration & Licences:\n- AHPRA registered nurse\n"
        out = to_canonical(md, NURSING_PROFILE)
        assert "## Registration & Licences:" in out


class TestEnsureBachelorRecognisesATrailingColonEducationHeading:
    _CV_TEXT = (
        "Experienced nurse. Bachelor of Nursing, University of Sydney, 2015-2018."
    )

    def test_REGRESSION_bachelor_recovery_runs_despite_the_colon(self):
        md = (
            "# Name\n\nContact\n\n"
            "## Education:\n"
            "### TAFE NSW | Sydney\n"
            "*Certificate III in Individual Support*\n\n"
            "## Experience\n- Did things.\n"
        )
        out = ensure_bachelor(md, self._CV_TEXT)
        assert "University of Sydney" in out
        assert "Bachelor of Nursing" in out

    def test_noop_when_a_bachelor_is_already_present_colon_and_all(self):
        md = (
            "## Education:\n"
            "### University of Sydney\n"
            "*Bachelor of Nursing*\n\n"
            "## Experience\n- Did things.\n"
        )
        assert ensure_bachelor(md, self._CV_TEXT) == md
