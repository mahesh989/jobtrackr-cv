"""Sprint H — fix tool surfacing scope + move misplaced technical skills.

Two bugs from the post-Sprint-G Anglicare run (GPT-5.1):

BUG 1. BESTMed/MedMobile missing from Skills section even though they
appear in Summary + Experience bullets. _surface_cv_named_tools was
checking 'is this tool anywhere in the markdown?' which incorrectly
short-circuited when tools appeared only in body prose. The candidate's
named tools must always reach the Skills line regardless.

BUG 2. 'Basic Smartphone Skills' landed in Soft Skills line. Feasibility
classified it TECHNICAL but the LLM placed it with Soft Skills (probably
grouped with 'Communication'). New _move_misplaced_technical_skills pass
hunts for technical vocabulary on the wrong line and moves it.
"""
from __future__ import annotations

from app.services.eval.writers import (
    _surface_cv_named_tools,
    _move_misplaced_technical_skills,
)
from app.services.eval.role_families import resolve_role_family


_NURSING_RF = resolve_role_family("nursing", {})
_TECH_RF = resolve_role_family("tech", {})


# ---------------------------------------------------------------------------
# Bug 1 — surfacer should scope check to Skills section only
# ---------------------------------------------------------------------------


class TestToolSurfacerScope:
    """When BESTMed/MedMobile appear in Summary or Experience body but NOT
    in the Skills section, they must be added to the Skills line. Previous
    behaviour (substring-anywhere check) skipped them."""

    def test_tools_in_summary_only_get_added_to_skills(self):
        md = """
## Professional Summary

Care worker using BESTMed and MedMobile at Jesmond.

## Skills

- **Care Skills:** Personal Care, Dementia Care
- **Soft Skills:** Compassion, Teamwork
- **Other Skills:** Basic Computer Skills

## Experience

Some text.
""".lstrip()
        cv = "Worker at Jesmond using BESTMed and MedMobile systems."
        out = _surface_cv_named_tools(md, cv, _NURSING_RF)
        # BESTMed and MedMobile must now appear in the Other Skills line.
        assert "BESTMed" in out
        assert "MedMobile" in out
        # Specifically: in the Skills section, not just elsewhere.
        skills_start = out.index("## Skills")
        next_section = out.index("## Experience")
        skills_section = out[skills_start:next_section]
        assert "BESTMed" in skills_section
        assert "MedMobile" in skills_section

    def test_tools_already_in_skills_no_duplicate(self):
        md = """
## Skills

- **Care Skills:** Personal Care
- **Soft Skills:** Compassion
- **Other Skills:** BESTMed, MedMobile, Basic Computer Skills

## Experience

Used BESTMed daily.
""".lstrip()
        cv = "Worker using BESTMed and MedMobile."
        out = _surface_cv_named_tools(md, cv, _NURSING_RF)
        # No duplicates added.
        assert out.count("BESTMed") == md.count("BESTMed")
        assert out.count("MedMobile") == md.count("MedMobile")

    def test_tool_not_in_cv_not_added(self):
        # Leecare is NOT in this CV → not added.
        md = """
## Skills

- **Care Skills:** Personal Care
- **Other Skills:** BESTMed
""".lstrip()
        cv = "Worker using BESTMed only."
        out = _surface_cv_named_tools(md, cv, _NURSING_RF)
        assert "Leecare" not in out

    def test_no_skills_section_noop(self):
        md = "## Experience\n\nUsed BESTMed daily."
        cv = "Worker using BESTMed."
        out = _surface_cv_named_tools(md, cv, _NURSING_RF)
        assert out == md


# ---------------------------------------------------------------------------
# Bug 2 — _move_misplaced_technical_skills
# ---------------------------------------------------------------------------


class TestMoveMisplacedTechnical:

    def test_basic_smartphone_skills_moves_from_soft_to_other(self):
        md = """
## Skills

- **Care Skills:** Personal Care, Dementia Care
- **Soft Skills:** Time Management, Teamwork, Basic Smartphone Skills, Compassion
- **Other Skills:** Basic Computer Skills
""".lstrip()
        out = _move_misplaced_technical_skills(md, _NURSING_RF)
        # Skills line that had 'Basic Smartphone Skills' no longer has it.
        soft_line = [ln for ln in out.split("\n") if "Soft Skills" in ln][0]
        assert "Basic Smartphone Skills" not in soft_line
        # Other Skills (target for nursing technical bucket) now has it.
        other_line = [ln for ln in out.split("\n") if "Other Skills" in ln][0]
        assert "Basic Smartphone Skills" in other_line

    def test_brand_tool_misplaced_in_care_moves_to_other(self):
        # If LLM put 'BESTMed' under Care Skills, move it to Other (for nursing).
        md = """
## Skills

- **Care Skills:** Personal Care, BESTMed, Dementia Care
- **Soft Skills:** Compassion
- **Other Skills:** MedMobile
""".lstrip()
        out = _move_misplaced_technical_skills(md, _NURSING_RF)
        care_line = [ln for ln in out.split("\n") if "Care Skills" in ln][0]
        assert "BESTMed" not in care_line
        other_line = [ln for ln in out.split("\n") if "Other Skills" in ln][0]
        assert "BESTMed" in other_line

    def test_no_misplaced_noop(self):
        md = """
## Skills

- **Care Skills:** Personal Care, Dementia Care
- **Soft Skills:** Compassion, Teamwork
- **Other Skills:** BESTMed, MedMobile
""".lstrip()
        out = _move_misplaced_technical_skills(md, _NURSING_RF)
        assert out == md

    def test_no_duplicate_when_already_in_target(self):
        md = """
## Skills

- **Care Skills:** Personal Care
- **Soft Skills:** Communication, Computer Skills
- **Other Skills:** Computer Skills, BESTMed
""".lstrip()
        out = _move_misplaced_technical_skills(md, _NURSING_RF)
        # Soft Skills loses Computer Skills; Other Skills doesn't double it.
        soft_line = [ln for ln in out.split("\n") if "Soft Skills" in ln][0]
        assert "Computer Skills" not in soft_line
        other_line = [ln for ln in out.split("\n") if "Other Skills" in ln][0]
        # Still only one Computer Skills in Other line.
        assert other_line.lower().count("computer skills") == 1

    def test_idempotent(self):
        md = """
## Skills

- **Care Skills:** Personal Care
- **Soft Skills:** Teamwork, Basic Smartphone Skills
- **Other Skills:** BESTMed
""".lstrip()
        once = _move_misplaced_technical_skills(md, _NURSING_RF)
        twice = _move_misplaced_technical_skills(once, _NURSING_RF)
        assert once == twice

    def test_tech_family_moves_to_technical_skills(self):
        # For tech role, technical bucket is "Technical Skills" line.
        # 'Computer Skills' misplaced under Soft moves to Technical.
        md = """
## Skills

- **Technical Skills:** Python, SQL
- **Soft Skills:** Communication, Computer Skills
- **Other Skills:** ETL Pipelines
""".lstrip()
        out = _move_misplaced_technical_skills(md, _TECH_RF)
        soft_line = [ln for ln in out.split("\n") if "Soft Skills" in ln][0]
        assert "Computer Skills" not in soft_line
        tech_line = [ln for ln in out.split("\n") if "Technical Skills" in ln][0]
        assert "Computer Skills" in tech_line
