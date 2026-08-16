"""Coverage gap (audit, execution chunk C42f, final chunk of C42's 6-way
split — C42a #197, C42b #198, C42c #201, C42d #202, C42e #203): the
top-level `run_tailored_structural_validation` entry point (runner.py) had
only INCIDENTAL coverage (each other chunk's tests call it to exercise one
gate at a time) — nothing asserted on the assembled report's own shape,
gate-set completeness, or graceful-degradation contract. The package's two
genuinely "trivial helper" modules (results.py's `_result`/`_short`,
shared by every gate; _common.py's pinned logger name) also had zero
direct coverage.
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation import (
    run_tailored_structural_validation,
)
from app.services.pipeline.steps.tailored_structural_validation._common import (
    logger,
)
from app.services.pipeline.steps.tailored_structural_validation.results import (
    _result,
    _short,
)

REALISTIC_JD_ANALYSIS = {
    "job_title": "Data Analyst",
    "required_skills": {
        "technical": ["SQL", "Python", "Tableau"],
        "soft_skills": ["communication"],
        "domain_knowledge": ["data warehousing"],
    },
    "preferred_skills": {"technical": ["dbt"], "soft_skills": [], "domain_knowledge": []},
}

REALISTIC_CV = """## Career Highlights
Data analyst with five years of experience building SQL-driven dashboards
and Tableau reports for retail clients, translating raw transactional data
into clear, decision-ready insights for non-technical stakeholders daily.

## Experience
### Data Analyst | Acme Co
*Jan 2020 – Present*
- Built 8 SQL dashboards in Tableau, cutting manual reporting time by 40%.
- Partnered with 5 stakeholders across teams to define KPI definitions.

## Education
### Springfield University | Springfield
*Master of Data Science | 2016 – 2018*

## Projects
### Sales Dashboard | github.com/example/dashboard
*Python, dbt | 2022*
- Built a Tableau dashboard on top of a SQL data warehouse.

## Skills
Technical Skills: SQL, Python, Tableau
Soft Skills: Communication, Teamwork, Leadership
Other Skills: Excel, PowerPoint, Word
"""

# The runner's own hardcoded gate assembly order (runner.py) — pinned so a
# future edit that silently drops or reorders a gate is caught here.
_EXPECTED_GATE_NAMES_IN_ORDER = [
    "profile_word_count",
    "seniority_literal_match",
    "experience_role_count",
    "education_count",
    "projects_count",
    "bullets_per_entry",
    "highlights_no_bullets",
    "experience_bullet_length",
    "period_terminator",
    "metric_coverage",
    "skills_min_per_category",
    "highlights_prose_shape",
    "highlights_reference_check",
    "degree_relevance",
    "project_relevance",
    "education_entry_shape",
    "project_entry_shape",
]


class TestRunTailoredStructuralValidation:
    def test_report_has_all_17_gates_in_the_documented_order(self):
        report = run_tailored_structural_validation(
            REALISTIC_CV, "", jd_analysis=REALISTIC_JD_ANALYSIS,
        )
        names = [g["name"] for g in report["gates"]]
        assert names == _EXPECTED_GATE_NAMES_IN_ORDER

    def test_summary_counts_are_internally_consistent(self):
        report = run_tailored_structural_validation(
            REALISTIC_CV, "", jd_analysis=REALISTIC_JD_ANALYSIS,
        )
        summary = report["summary"]
        assert summary["total"] == 17
        assert summary["pass"] + summary["warn"] + summary["fail"] == 17
        # Cross-check the summary tally against the gates list itself.
        assert summary["pass"] == sum(1 for g in report["gates"] if g["status"] == "pass")
        assert summary["warn"] == sum(1 for g in report["gates"] if g["status"] == "warn")
        assert summary["fail"] == sum(1 for g in report["gates"] if g["status"] == "fail")

    def test_empty_markdown_still_returns_a_full_report_without_raising(self):
        report = run_tailored_structural_validation("", "", jd_analysis=REALISTIC_JD_ANALYSIS)
        assert report["summary"]["total"] == 17
        assert "error" not in report

    def test_none_markdown_is_defaulted_to_empty_string_not_raised_on(self):
        report = run_tailored_structural_validation(None, "", jd_analysis=None)  # type: ignore[arg-type]
        assert report["summary"]["total"] == 17

    def test_jd_analysis_omitted_relevance_gates_skip_gracefully_as_pass(self):
        report = run_tailored_structural_validation(REALISTIC_CV, "")
        gates = {g["name"]: g for g in report["gates"]}
        assert gates["degree_relevance"]["status"] == "pass"
        assert gates["project_relevance"]["status"] == "pass"

    def test_original_cv_text_and_jd_analysis_both_default_when_omitted(self):
        # Positional-default smoke test — only tailored_markdown is required.
        report = run_tailored_structural_validation(REALISTIC_CV)
        assert report["summary"]["total"] == 17

    def test_never_raises_on_structurally_hostile_input(self):
        hostile = "#" * 5000 + "\n" + ("*" * 3 + "\n") * 50
        report = run_tailored_structural_validation(hostile, hostile, jd_analysis={})
        assert report["summary"]["total"] == 17
        assert "error" not in report


class TestResultHelper:
    def test_builds_the_documented_dict_shape(self):
        assert _result("my_gate", "warn", "some detail") == {
            "name": "my_gate", "status": "warn", "detail": "some detail",
        }


class TestShortHelper:
    def test_returns_text_unchanged_when_at_or_under_the_limit(self):
        assert _short("short text", 50) == "short text"

    def test_boundary_exactly_at_the_limit_is_unchanged(self):
        text = "x" * 50
        assert _short(text, 50) == text

    def test_truncates_and_appends_an_ellipsis_when_over_the_limit(self):
        text = "x" * 60
        result = _short(text, 50)
        assert len(result) == 50
        assert result.endswith("…")
        assert result == "x" * 49 + "…"

    def test_strips_surrounding_whitespace_before_measuring_length(self):
        assert _short("   short text   ", 50) == "short text"

    def test_none_input_is_treated_as_empty_string(self):
        assert _short(None, 50) == ""  # type: ignore[arg-type]

    def test_default_limit_is_50_when_n_is_omitted(self):
        text = "x" * 60
        assert _short(text) == "x" * 49 + "…"


class TestLoggerNamePinning:
    def test_logger_name_matches_the_pre_split_module_path(self):
        # _common.py's own docstring: pinned to the ORIGINAL module path
        # rather than __name__, so log output stays byte-identical across
        # the package split.
        assert logger.name == "app.services.pipeline.steps.tailored_structural_validation"
