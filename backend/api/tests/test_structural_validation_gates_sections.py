"""Coverage gap (audit, execution chunk C42e): tailored_structural_validation/
gates_sections.py's REMAINDER — the 5 gates not already covered by C42c
(degree_relevance/project_relevance, test_relevance.py, #201): education
count, projects count, skills-per-category, and the education/project
two-line entry-shape gates. Part of C42's 6-way split (C42a #197, C42b
#198, C42c #201, C42d #202).

All gates here are advisory (warn/pass/fail feed the admin quality
dashboard and TailoredScoreCard only — never block CV delivery).
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation.gates_sections import (
    _gate_education_count,
    _gate_education_entry_shape,
    _gate_project_entry_shape,
    _gate_projects_count,
    _gate_skills_min_per_category,
    _resolve_expected_skills_labels,
)


# ---------------------------------------------------------------------------
# _gate_education_count
# ---------------------------------------------------------------------------


class TestGateEducationCount:
    def test_no_education_section_warns(self):
        result = _gate_education_count({})
        assert result["status"] == "warn"
        assert "No education section detected" in result["detail"]

    def test_whitespace_only_body_is_treated_as_empty_and_fails(self):
        # _resolve_section returns whatever's stored verbatim; calling the
        # gate directly (bypassing _split_sections' own .strip()) can hand
        # it a truthy-but-blank body, exercising the n==0 fail branch that
        # the full pipeline can't normally reach.
        result = _gate_education_count({"education": "   \n   "})
        assert result["status"] == "fail"
        assert "Education section is empty" in result["detail"]

    def test_one_to_three_entries_passes(self):
        body = "Bachelor of Science, Uni A, 2020\n\nMaster of Science, Uni B, 2022"
        result = _gate_education_count({"education": body})
        assert result["status"] == "pass"
        assert "2 education entry/entries" in result["detail"]

    def test_boundary_exactly_three_entries_passes(self):
        body = "\n\n".join(f"Degree {i}" for i in range(3))
        result = _gate_education_count({"education": body})
        assert result["status"] == "pass"

    def test_boundary_four_entries_warns(self):
        body = "\n\n".join(f"Degree {i}" for i in range(4))
        result = _gate_education_count({"education": body})
        assert result["status"] == "warn"
        assert "target 1-3" in result["detail"]


# ---------------------------------------------------------------------------
# _gate_projects_count
# ---------------------------------------------------------------------------


class TestGateProjectsCount:
    def test_no_projects_section_warns(self):
        result = _gate_projects_count({})
        assert result["status"] == "warn"
        assert "No Projects section" in result["detail"]

    def test_one_to_two_projects_passes(self):
        body = "### Project A\n- Did a thing.\n### Project B\n- Did another.\n"
        result = _gate_projects_count({"projects": body})
        assert result["status"] == "pass"
        assert "2 project(s)" in result["detail"]

    def test_boundary_three_projects_warns(self):
        body = "".join(f"### Project {i}\n- Did it.\n" for i in range(3))
        result = _gate_projects_count({"projects": body})
        assert result["status"] == "warn"
        assert "target 1-2" in result["detail"]

    def test_boundary_exactly_four_projects_still_warns_not_fails(self):
        body = "".join(f"### Project {i}\n- Did it.\n" for i in range(4))
        result = _gate_projects_count({"projects": body})
        assert result["status"] == "warn"

    def test_boundary_five_projects_fails(self):
        body = "".join(f"### Project {i}\n- Did it.\n" for i in range(5))
        result = _gate_projects_count({"projects": body})
        assert result["status"] == "fail"
        assert "target is 1-2" in result["detail"]

    def test_projects_body_present_but_no_parseable_entries_passes_as_zero(self):
        # Orphan bullets with no preceding title parse to zero entries —
        # pinned as characterization, not "no Projects section".
        result = _gate_projects_count({"projects": "- Orphan bullet.\n"})
        assert result["status"] == "pass"
        assert "0 project(s)" in result["detail"]


# ---------------------------------------------------------------------------
# _resolve_expected_skills_labels
# ---------------------------------------------------------------------------


class TestResolveExpectedSkillsLabels:
    _FALLBACK = {"technical skills", "soft skills", "other skills"}

    def test_none_jd_analysis_falls_back_to_tech_shape(self):
        assert _resolve_expected_skills_labels(None) == self._FALLBACK

    def test_missing_category_labels_key_falls_back(self):
        assert _resolve_expected_skills_labels({"job_title": "x"}) == self._FALLBACK

    def test_dict_shape_is_lowercased_and_used_verbatim(self):
        labels = {
            "technical": "Other Skills",
            "soft_skills": "Soft Skills",
            "domain_knowledge": "Care Skills",
        }
        result = _resolve_expected_skills_labels({"category_labels": labels})
        assert result == {"other skills", "soft skills", "care skills"}

    def test_empty_dict_category_labels_falls_back(self):
        result = _resolve_expected_skills_labels({"category_labels": {}})
        assert result == self._FALLBACK

    def test_legacy_list_shape_of_three_or_more_is_used(self):
        result = _resolve_expected_skills_labels(
            {"category_labels": ["Core Skills", "Soft Skills", "Other Skills"]}
        )
        assert result == {"core skills", "soft skills", "other skills"}

    def test_legacy_list_shape_under_three_falls_back(self):
        result = _resolve_expected_skills_labels(
            {"category_labels": ["Core Skills", "Soft Skills"]}
        )
        assert result == self._FALLBACK


# ---------------------------------------------------------------------------
# _gate_skills_min_per_category
# ---------------------------------------------------------------------------


_TECH_EXPECTED = {"technical skills", "soft skills", "other skills"}


class TestGateSkillsMinPerCategory:
    def test_no_skills_section_warns(self):
        result = _gate_skills_min_per_category({}, _TECH_EXPECTED)
        assert result["status"] == "warn"
        assert "No skills section detected" in result["detail"]

    def test_all_categories_present_with_enough_skills_passes(self):
        body = (
            "Technical Skills: SQL, Python, Tableau\n"
            "Soft Skills: Communication, Teamwork, Leadership\n"
            "Other Skills: Excel, PowerPoint, Word\n"
        )
        result = _gate_skills_min_per_category({"skills": body}, _TECH_EXPECTED)
        assert result["status"] == "pass"

    def test_bold_label_format_is_parsed(self):
        body = "**Technical Skills:** SQL, Python, Tableau\n"
        result = _gate_skills_min_per_category(
            {"skills": body}, {"technical skills"},
        )
        assert result["status"] == "pass"

    def test_pipe_separated_subgroups_are_flattened_for_the_count(self):
        body = "Technical Skills: SQL | Python, Tableau\n"
        result = _gate_skills_min_per_category(
            {"skills": body}, {"technical skills"},
        )
        assert result["status"] == "pass"

    def test_category_with_fewer_than_three_skills_is_flagged(self):
        body = "Technical Skills: SQL, Python\n"
        result = _gate_skills_min_per_category(
            {"skills": body}, {"technical skills"},
        )
        assert "categories with <3 skills" in result["detail"]
        assert "Technical Skills: 2 skill(s)" in result["detail"]

    def test_missing_required_category_fails(self):
        body = "Technical Skills: SQL, Python, Tableau\n"
        result = _gate_skills_min_per_category({"skills": body}, _TECH_EXPECTED)
        assert result["status"] == "fail"
        assert "missing required categories" in result["detail"]

    def test_non_standard_extra_category_alone_warns_not_fails(self):
        body = (
            "Technical Skills: SQL, Python, Tableau\n"
            "Soft Skills: Communication, Teamwork, Leadership\n"
            "Other Skills: Excel, PowerPoint, Word\n"
            "Languages: English, Spanish, French\n"
        )
        result = _gate_skills_min_per_category({"skills": body}, _TECH_EXPECTED)
        assert result["status"] == "warn"
        assert "non-standard categories" in result["detail"]

    def test_no_category_colon_lines_at_all_fails(self):
        body = "Just a paragraph with no category labels."
        result = _gate_skills_min_per_category({"skills": body}, _TECH_EXPECTED)
        assert result["status"] == "fail"
        assert "no 'Category: skill, skill' lines" in result["detail"]


# ---------------------------------------------------------------------------
# _gate_education_entry_shape
# ---------------------------------------------------------------------------


class TestGateEducationEntryShape:
    def test_no_education_section_warns(self):
        result = _gate_education_entry_shape({})
        assert result["status"] == "warn"
        assert "No Education section to check" in result["detail"]

    def test_bullet_list_with_no_title_lines_fails_loudly(self):
        body = "- Bachelor of Science, Uni A, 2020\n- Master of Science, Uni B, 2022\n"
        result = _gate_education_entry_shape({"education": body})
        assert result["status"] == "fail"
        assert "renderer cannot align" in result["detail"]

    def test_all_entries_two_line_shape_passes(self):
        body = "### Big University | City\n*Bachelor of Science | 2018 – 2022*\n"
        result = _gate_education_entry_shape({"education": body})
        assert result["status"] == "pass"

    def test_entry_missing_the_subline_fails(self):
        body = "### Big University | City\nJust a plain paragraph, not italic.\n"
        result = _gate_education_entry_shape({"education": body})
        assert result["status"] == "fail"


# ---------------------------------------------------------------------------
# _gate_project_entry_shape
# ---------------------------------------------------------------------------


class TestGateProjectEntryShape:
    def test_no_projects_section_passes(self):
        result = _gate_project_entry_shape({})
        assert result["status"] == "pass"
        assert "No Projects section" in result["detail"]

    def test_two_line_shape_with_pipe_on_title_line_passes(self):
        body = "### Sales Dashboard | github.com/example\n*Python, dbt | 2022*\n"
        result = _gate_project_entry_shape({"projects": body})
        assert result["status"] == "pass"

    def test_missing_subline_fails_before_the_pipe_check_even_runs(self):
        body = "### Sales Dashboard | github.com/example\nPlain paragraph, no subline.\n"
        result = _gate_project_entry_shape({"projects": body})
        assert result["status"] == "fail"

    def test_title_line_missing_a_pipe_fails_even_with_a_valid_subline(self):
        body = "### Sales Dashboard\n*Python, dbt | 2022*\n"
        result = _gate_project_entry_shape({"projects": body})
        assert result["status"] == "fail"
        assert "missing ` | <right>` on Line 1" in result["detail"]
