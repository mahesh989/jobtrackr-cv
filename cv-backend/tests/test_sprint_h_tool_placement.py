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
    _surface_matched_skills,
    _resolve_skills_category_map,
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


# ---------------------------------------------------------------------------
# Sprint K — nursing label↔category mapping. The "Infection Prevention
# And Control Requirements"-in-Other-Skills leak. For nursing/manual the
# JD's CARE/Care skill content (matched as domain_knowledge) MUST land in
# the "Care/Clinical/Core Skills" line, NOT in "Other Skills" (which is the
# tools line for these families). The universal _SKILLS_CATEGORY_LABEL maps
# domain_knowledge → "Other Skills" which is correct for tech but inverted
# for nursing.
# ---------------------------------------------------------------------------


class TestNursingCategoryMapping:

    NURSING_MD = (
        "## Skills\n\n"
        "- **Care Skills:** Person-Centred Care, Medication Assistance\n"
        "- **Soft Skills:** Teamwork\n"
        "- **Other Skills:** BESTMed, MedMobile\n\n"
        "## Experience\n"
    )

    TECH_MD = (
        "## Skills\n\n"
        "- **Technical Skills:** Python, SQL\n"
        "- **Soft Skills:** Teamwork\n"
        "- **Other Skills:** Healthcare Domain\n\n"
        "## Experience\n"
    )

    def _line_of(self, md, label):
        return next(ln for ln in md.split("\n") if label in ln)

    def test_nursing_layout_resolves_first_line_as_domain_knowledge(self):
        lines = self.NURSING_MD.split("\n")
        ss = lines.index("## Skills")
        se = lines.index("## Experience")
        m = _resolve_skills_category_map(lines, ss, se)
        # Care Skills (line 2) carries clinical/care = domain_knowledge content
        # Other Skills (line 4) carries tools = technical content
        assert m["domain_knowledge"] == 2, f"map={m}"
        assert m["soft_skills"] == 3, f"map={m}"
        assert m["technical"] == 4, f"map={m}"

    def test_tech_layout_resolves_canonically(self):
        lines = self.TECH_MD.split("\n")
        ss = lines.index("## Skills")
        se = lines.index("## Experience")
        m = _resolve_skills_category_map(lines, ss, se)
        # Technical Skills (line 2) = technical; Other Skills (line 4) = domain
        assert m["technical"] == 2, f"map={m}"
        assert m["soft_skills"] == 3, f"map={m}"
        assert m["domain_knowledge"] == 4, f"map={m}"

    def test_clinical_skills_headline_also_resolves(self):
        md = self.NURSING_MD.replace("**Care Skills:**", "**Clinical Skills:**")
        lines = md.split("\n")
        ss = lines.index("## Skills")
        se = lines.index("## Experience")
        m = _resolve_skills_category_map(lines, ss, se)
        assert m["domain_knowledge"] == 2

    def test_core_skills_headline_also_resolves(self):
        md = self.NURSING_MD.replace("**Care Skills:**", "**Core Skills:**")
        lines = md.split("\n")
        ss = lines.index("## Skills")
        se = lines.index("## Experience")
        m = _resolve_skills_category_map(lines, ss, se)
        assert m["domain_knowledge"] == 2

    def test_nursing_matched_domain_lands_in_care_not_other_skills(self):
        """The user-reported bug: 'Infection Prevention And Control Requirements'
        was a JD CARE term (domain_knowledge for nursing). Under the old map,
        domain_knowledge → "Other Skills" label → it bled into the tools line.
        With the fix it lands in the Care Skills line, where it belongs.
        """
        matching = {"matched": {"required": {
            "domain_knowledge": ["infection prevention and control requirements"],
            "technical": [],
            "soft_skills": [],
        }}}
        out = _surface_matched_skills(self.NURSING_MD, matching)
        care_line = self._line_of(out, "Care Skills")
        other_line = self._line_of(out, "Other Skills")
        assert "Infection Prevention And Control Requirements" in care_line
        assert "Infection Prevention And Control Requirements" not in other_line
        # Tools line must STAY tools-only.
        assert "BESTMed" in other_line
        assert "MedMobile" in other_line

    def test_nursing_matched_technical_lands_in_other_skills(self):
        """The inverse: a matched 'technical' item (tool name) routes to
        Other Skills for nursing, NOT Care Skills."""
        matching = {"matched": {"required": {
            "domain_knowledge": [],
            "technical": ["epic emr"],
            "soft_skills": [],
        }}}
        out = _surface_matched_skills(self.NURSING_MD, matching)
        care_line = self._line_of(out, "Care Skills")
        other_line = self._line_of(out, "Other Skills")
        assert "Epic EMR" in other_line or "Epic Emr" in other_line
        assert "epic" not in care_line.lower()

    def test_tech_matched_technical_lands_in_technical_skills(self):
        """For tech, matched 'technical' goes to Technical Skills line (headline).
        No regression from the nursing fix."""
        matching = {"matched": {"required": {
            "technical": ["kubernetes"],
            "domain_knowledge": ["saas"],
            "soft_skills": [],
        }}}
        out = _surface_matched_skills(self.TECH_MD, matching)
        tech_line = self._line_of(out, "Technical Skills")
        other_line = self._line_of(out, "Other Skills")
        assert "Kubernetes" in tech_line
        assert "Saas" in other_line or "SaaS" in other_line
