"""
Execution chunk C22f — the deliberately-deferred follow-up from C22b's own
independent review (PR #173, 3 review rounds): "## Heading" extraction with
no trailing-colon stripping defeats an exact/membership heading-name match
(`_SECTION_ALIASES.get(...)`, `heading == WANT`, a compiled `$`-anchored
regex, etc.) — an AI-emitted "## Career Highlights:" (trailing colon) is
invisible to every one of these checks. C22b fixed the highest-impact site
(enforce_w8.py's `_rename_headings`, which feeds the ENTIRE frozen
production contract) and 4 siblings in the same file, and documented 6+
more files sharing the identical pattern as an explicit, deliberately
out-of-scope follow-up — this file closes that sweep.

Files covered (mirroring C22b's own methodology: read every heading-match
call site in each named file, not just the originally-cited line numbers,
which drift as the file changes):
  • eval/verify.py            — _collect_bullets, _collect_summary
  • eval/enforce_w3.py        — _section_bounds (shared by 5 call sites:
                                 _strip_ai_skills, _strip_ai_projects,
                                 clamp_two_sentences x2, strip_off_vertical_preamble)
  • eval/writers/bridges.py   — _apply_setting_bridge
  • pipeline/steps/tailored_cv/structure.py — _enforce_career_highlights_words,
    _dedup_career_highlights, and the EXP_HEADING/PROJ_HEADING == comparison
    inside _enforce_structure itself
  • pipeline/steps/tailored_cv/summary.py   — _find_summary_block (_SUMMARY_HEADING_RE)

Also closes the "tech/master _rename_headings no-ops" half of C22f: those
families' _TO_CANONICAL mapping is intentionally empty (their AI prompt
already emits canonical heading names), so _rename_headings early-returns
without touching the line — meaning a colon'd heading for those families
was NEVER stripped by anything upstream of _enforce_structure. The
_enforce_structure end-to-end test below proves this is no longer a blind
spot: it's the SAME code path nursing/manual go through post-rename, and
now tolerates a trailing colon regardless of family.
"""
from __future__ import annotations

from app.services.eval.enforce_w3 import (
    _section_bounds,
    _strip_ai_skills,
    clamp_two_sentences,
)
from app.services.eval.verify import _collect_bullets, _collect_summary
from app.services.eval.writers.bridges import _apply_setting_bridge, _SETTING_HOSPITAL
from app.services.pipeline.steps.tailored_cv import _enforce_structure
from app.services.pipeline.steps.tailored_cv.structure import (
    _dedup_career_highlights,
    _enforce_career_highlights_words,
)
from app.services.pipeline.steps.tailored_cv.summary import _find_summary_block


# ---------------------------------------------------------------------------
# eval/verify.py
# ---------------------------------------------------------------------------


class TestVerifyPyTrailingColon:
    def test_collect_bullets_recognises_a_colon_headed_experience_section(self):
        md = (
            "## Experience:\n"
            "- Provided patient care in acute ward.\n"
        )
        bullets = _collect_bullets(md)
        assert len(bullets) == 1
        assert bullets[0][1] == "Provided patient care in acute ward."

    def test_collect_summary_recognises_a_colon_headed_summary_section(self):
        md = "## Career Highlights:\nExperienced nurse with acute care background.\n"
        result = _collect_summary(md)
        assert result is not None
        _idxs, text = result
        assert "Experienced nurse" in text


# ---------------------------------------------------------------------------
# eval/enforce_w3.py — fixed once at the shared _section_bounds entry point
# ---------------------------------------------------------------------------


class TestEnforceW3TrailingColon:
    def test_section_bounds_matches_a_colon_headed_line(self):
        lines = ["## Skills:", "- SQL", "## Experience", "- x"]
        bounds = _section_bounds(lines, lambda s: s.lower() == "## skills")
        assert bounds == (0, 2)

    def test_strip_ai_skills_still_strips_under_a_colon_headed_heading(self):
        md = (
            "## Skills:\n"
            "**Technical Skills:** Python, TensorFlow, PyTorch\n"
            "**Soft Skills:** Communication\n"
        )
        out = _strip_ai_skills(md)
        assert "TensorFlow" not in out
        assert "PyTorch" not in out
        assert "Python" in out

    def test_clamp_two_sentences_still_clamps_under_a_colon_headed_heading(self):
        md = (
            "## Career Highlights:\n"
            "First sentence here. Second sentence here. Third sentence here.\n\n"
            "## Experience\n- x\n"
        )
        out = clamp_two_sentences(md)
        assert "Third sentence" not in out
        assert "First sentence" in out
        assert "Second sentence" in out


# ---------------------------------------------------------------------------
# eval/writers/bridges.py
# ---------------------------------------------------------------------------


class TestBridgesPyTrailingColon:
    def test_setting_bridge_still_applies_under_a_colon_headed_heading(self):
        md = (
            "## Career Highlights:\n"
            "Experienced carer with experience in residential aged care settings.\n\n"
            "## Experience\n- Did care.\n"
        )
        out = _apply_setting_bridge(
            md, _SETTING_HOSPITAL, cv_text="Worked at City Hospital for 3 years.",
        )
        assert "acute clinical settings" in out
        assert out != md


# ---------------------------------------------------------------------------
# pipeline/steps/tailored_cv/structure.py
# ---------------------------------------------------------------------------


def _words(n: int) -> str:
    return " ".join(["word"] * n)


class TestStructurePyTrailingColon:
    def test_enforce_career_highlights_words_still_trims_under_a_colon_headed_heading(self):
        # s2 (45 words, no internal punctuation) must exceed _trim_to_words'
        # flex_cap window (s2_max + 10) so it actually hard-cuts rather than
        # keeping the whole clause intact.
        md = f"## Career Highlights:\n{_words(30)}. {_words(45)}.\n\n## Experience\n- x\n"
        out = _enforce_career_highlights_words(md, max_words=50)
        prose = out.split("## Career Highlights:\n", 1)[1].split("## Experience")[0]
        assert len(prose.split()) < 75, "expected trimming to actually occur"

    def test_dedup_career_highlights_still_dedupes_under_a_colon_headed_heading(self):
        md = (
            "## Career Highlights:\nFirst version.\n\n"
            "## Career Highlights:\nSecond version (duplicate).\n\n"
            "## Experience\n- x\n"
        )
        out = _dedup_career_highlights(md)
        assert out.count("## Career Highlights:") == 1
        assert "Second version" not in out

    def test_enforce_structure_caps_experience_roles_under_a_colon_headed_heading(self):
        # Also proves the tech/master "_rename_headings no-ops on an empty
        # mapping" blind spot is closed: this is the exact downstream check
        # (_enforce_structure) that a tech/master CV's colon'd heading would
        # otherwise reach completely unstripped, since to_canonical() never
        # touches those families' headings at all (mapping = {}).
        md = (
            "# Name\n\n"
            "## Professional Experience:\n"
            "### Role A\n- Did a thing.\n\n"
            "### Role B\n- Did another.\n\n"
            "### Role C\n- Did a third.\n\n"
            "### Role D\n- Did a fourth.\n"
        )
        out = _enforce_structure(md)
        assert out.count("### Role") == 3, "expected the 3-role cap to apply"
        assert "Role D" not in out


# ---------------------------------------------------------------------------
# pipeline/steps/tailored_cv/summary.py
# ---------------------------------------------------------------------------


class TestSummaryPyTrailingColon:
    def test_find_summary_block_recognises_a_colon_headed_heading(self):
        lines = "## Career Highlights:\nProse here.\n\n## Experience\n- x\n".split("\n")
        start, end = _find_summary_block(lines)
        assert start is not None
        assert lines[start] == "## Career Highlights:"
