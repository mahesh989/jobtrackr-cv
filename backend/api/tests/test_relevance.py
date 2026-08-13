"""
Regression test for #5 (audit, execution chunk C48): _build_jd_vocabulary
read field names jd_analysis has never had ("keywords"/"role_title") instead
of the real schema ("required_skills"/"preferred_skills"/"job_title" — see
jd_analysis.py's own docstring). It always returned an EMPTY vocabulary, so
the two gates that depend on it (degree_relevance, project_relevance) always
hit their "no JD analysis available" skip branch and reported "pass" no
matter how irrelevant the CV's grad degree or project actually was — 2 of
17 structural gates permanently dead since shipping.

These gates are advisory-only (soft "warn", never "fail", and the report
is stored informationally — it does not block or alter CV delivery), so
the blast radius of turning them back on is a more accurate report, not a
new hard gate.
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation import (
    run_tailored_structural_validation,
)
from app.services.pipeline.steps.tailored_structural_validation.relevance import (
    _build_jd_vocabulary,
)

REALISTIC_JD_ANALYSIS = {
    "job_title": "Data Analyst",
    "seniority_level": "mid",
    "summary": "Analyse business data and build dashboards.",
    "responsibilities": ["Build SQL queries", "Maintain Tableau dashboards"],
    "required_skills": {
        "technical": ["SQL", "Python", "Tableau"],
        "soft_skills": ["communication"],
        "domain_knowledge": ["data warehousing"],
    },
    "preferred_skills": {
        "technical": ["dbt"],
        "soft_skills": [],
        "domain_knowledge": [],
    },
}

IRRELEVANT_DEGREE_CV = """## Career Highlights
Experienced analyst.

## Experience
### Data Analyst | Acme Co
Jan 2020 - Present
- Built SQL dashboards in Tableau.

## Education
Master of Fine Arts, Sculpture — Springfield Art Institute, 2015
"""

RELEVANT_DEGREE_CV = """## Career Highlights
Experienced analyst.

## Experience
### Data Analyst | Acme Co
Jan 2020 - Present
- Built SQL dashboards in Tableau.

## Education
Master of Data Science — Springfield University, 2018
"""


def _gate(report, name):
    return next(g for g in report["gates"] if g["name"] == name)


class TestBuildJdVocabulary:
    def test_REGRESSION_returns_non_empty_vocab_for_a_realistic_jd_analysis(self):
        vocab = _build_jd_vocabulary(REALISTIC_JD_ANALYSIS)
        assert vocab, "expected a non-empty vocabulary from a realistic jd_analysis"
        # Tokens from required_skills.technical and job_title should be present.
        assert "python" in vocab
        assert "tableau" in vocab
        assert "analyst" in vocab  # from job_title "Data Analyst"

    def test_empty_jd_analysis_still_returns_empty_vocab(self):
        assert _build_jd_vocabulary({}) == set()
        assert _build_jd_vocabulary(None) == set()  # type: ignore[arg-type]


class TestDegreeRelevanceGate:
    def test_REGRESSION_warns_on_an_irrelevant_graduate_degree(self):
        report = run_tailored_structural_validation(
            IRRELEVANT_DEGREE_CV, "", jd_analysis=REALISTIC_JD_ANALYSIS,
        )
        gate = _gate(report, "degree_relevance")
        assert gate["status"] == "warn", gate["detail"]

    def test_does_not_warn_on_a_relevant_graduate_degree(self):
        report = run_tailored_structural_validation(
            RELEVANT_DEGREE_CV, "", jd_analysis=REALISTIC_JD_ANALYSIS,
        )
        gate = _gate(report, "degree_relevance")
        assert gate["status"] == "pass", gate["detail"]

    def test_still_skips_gracefully_when_jd_analysis_is_omitted(self):
        report = run_tailored_structural_validation(IRRELEVANT_DEGREE_CV, "", jd_analysis=None)
        gate = _gate(report, "degree_relevance")
        assert gate["status"] == "pass"
        assert "no jd analysis" in gate["detail"].lower()
