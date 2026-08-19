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

Coverage gap (audit, execution chunk C42c): the classes below this
docstring's original two (TestBuildJdVocabulary, TestDegreeRelevanceGate)
were added later to close out C42's own scoping for relevance.py — the
module's other 3 functions (_normalise_token, _tokenise_for_relevance,
_has_overlap) and the sibling project_relevance gate (gates_sections.py)
had zero direct coverage before this pass. See C42a's own docstring for
the full 6-way split rationale.
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation import (
    run_tailored_structural_validation,
)
from app.services.pipeline.steps.tailored_structural_validation.relevance import (
    _build_jd_vocabulary,
    _has_overlap,
    _normalise_token,
    _tokenise_for_relevance,
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

IRRELEVANT_PROJECT_CV = """## Career Highlights
Experienced analyst.

## Experience
### Data Analyst | Acme Co
Jan 2020 - Present
- Built SQL dashboards in Tableau.

## Projects
### Backyard Vegetable Garden Planner | github.com/example/garden
*Notion, watercolour sketches | 2021*
- Sketched a seasonal planting rotation for a home garden.
"""

RELEVANT_PROJECT_CV = """## Career Highlights
Experienced analyst.

## Experience
### Data Analyst | Acme Co
Jan 2020 - Present
- Built SQL dashboards in Tableau.

## Projects
### Sales Dashboard | github.com/example/dashboard
*Python, dbt | 2022*
- Built a Tableau dashboard on top of a SQL data warehouse.
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

    def test_reads_preferred_skills_bucket_not_just_required(self):
        vocab = _build_jd_vocabulary({
            "required_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
            "preferred_skills": {"technical": ["Kubernetes"], "soft_skills": [], "domain_knowledge": []},
        })
        assert "kubernetes" in vocab

    def test_reads_soft_skills_and_domain_knowledge_categories_not_just_technical(self):
        vocab = _build_jd_vocabulary({
            "required_skills": {
                "technical": [],
                "soft_skills": ["Stakeholder Management"],
                "domain_knowledge": ["Aged Care"],
            },
        })
        assert "stakeholder" in vocab
        assert "management" in vocab
        assert "aged" in vocab
        assert "care" in vocab

    def test_non_string_job_title_is_ignored_not_crashed_on(self):
        vocab = _build_jd_vocabulary({"job_title": None})
        assert vocab == set()
        vocab = _build_jd_vocabulary({"job_title": 12345})
        assert vocab == set()

    def test_missing_skills_buckets_default_to_empty_rather_than_raising(self):
        # No required_skills/preferred_skills keys at all — only job_title.
        vocab = _build_jd_vocabulary({"job_title": "Data Analyst"})
        assert vocab == {"data", "analyst"}


class TestNormaliseToken:
    def test_lowercases(self):
        assert _normalise_token("PYTHON") == "python"

    def test_strips_non_alphanumeric_characters(self):
        assert _normalise_token("C++") == "c"
        assert _normalise_token("Node.js") == "nodejs"

    def test_punctuation_only_input_yields_empty_string(self):
        assert _normalise_token("---") == ""


class TestTokeniseForRelevance:
    def test_splits_on_whitespace_and_normalises_each_token(self):
        assert _tokenise_for_relevance("Python SQL") == ["python", "sql"]

    def test_removes_stopwords(self):
        toks = _tokenise_for_relevance("experience in data analysis and the cloud")
        assert "and" not in toks
        assert "the" not in toks
        assert "in" not in toks
        assert "data" in toks
        assert "cloud" in toks

    def test_removes_tokens_shorter_than_3_characters(self):
        # "ai" is exactly 2 chars post-normalisation — dropped by the
        # length filter, not the stopword list (it isn't a stopword).
        toks = _tokenise_for_relevance("ai ml sql")
        assert "ai" not in toks
        assert "ml" not in toks
        assert "sql" in toks

    def test_empty_string_yields_empty_list(self):
        assert _tokenise_for_relevance("") == []

    def test_none_yields_empty_list_rather_than_raising(self):
        assert _tokenise_for_relevance(None) == []  # type: ignore[arg-type]


class TestHasOverlap:
    def test_exact_token_match(self):
        assert _has_overlap(["python", "excel"], {"python"}) == ["python"]

    def test_prefix_match_forward_direction_vocab_word_starts_with_token_head(self):
        # Module docstring's own example: "marketing" (vocab) should match
        # "marketers" (candidate token) via a shared 5-char stem.
        assert _has_overlap(["marketers"], {"marketing"}) == ["marketers"]

    def test_prefix_match_reverse_direction_short_vocab_word_matches_a_longer_token(self):
        # "cpp" (3-char vocab abbreviation) is shorter than the 5-char
        # prefix window, so only the head.startswith(v[:5]) branch can
        # fire here — v.startswith(head) is false because v is shorter
        # than head. Pins that this reverse branch is reachable.
        assert _has_overlap(["cppdeveloper"], {"cpp"}) == ["cppdeveloper"]

    def test_empty_vocab_returns_no_matches(self):
        assert _has_overlap(["python", "sql"], set()) == []

    def test_no_shared_stem_returns_empty_list(self):
        assert _has_overlap(["sculpture", "painting"], {"python", "tableau"}) == []

    def test_returns_only_the_matching_subset_preserving_input_order(self):
        result = _has_overlap(["sculpture", "python", "painting", "sql"], {"python", "sql"})
        assert result == ["python", "sql"]


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


class TestProjectRelevanceGate:
    """Zero prior coverage — test_relevance.py's original regression test
    (C48) only exercised degree_relevance; this is the sibling gate that
    shares the same _build_jd_vocabulary/_has_overlap machinery.
    """

    def test_warns_on_an_off_topic_project(self):
        report = run_tailored_structural_validation(
            IRRELEVANT_PROJECT_CV, "", jd_analysis=REALISTIC_JD_ANALYSIS,
        )
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "warn", gate["detail"]

    def test_does_not_warn_on_a_relevant_project(self):
        report = run_tailored_structural_validation(
            RELEVANT_PROJECT_CV, "", jd_analysis=REALISTIC_JD_ANALYSIS,
        )
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "pass", gate["detail"]

    def test_skips_gracefully_when_jd_analysis_is_omitted(self):
        report = run_tailored_structural_validation(IRRELEVANT_PROJECT_CV, "", jd_analysis=None)
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "pass"
        assert "no jd analysis" in gate["detail"].lower()

    def test_passes_when_no_projects_section(self):
        cv = "## Career Highlights\nExperienced analyst.\n"
        report = run_tailored_structural_validation(cv, "", jd_analysis=REALISTIC_JD_ANALYSIS)
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "pass"
        assert "no projects section" in gate["detail"].lower()

    def test_passes_when_projects_section_has_no_parseable_entries(self):
        # _parse_entries only starts an entry at a title line; a bullet
        # with no preceding title is an orphan it silently drops (see
        # test_structural_validation_parsing.py's own coverage of this),
        # so a Projects section containing only orphan bullets yields zero
        # entries rather than one entry with an empty title.
        cv = "## Projects\n- Orphan bullet with no title above it.\n"
        report = run_tailored_structural_validation(cv, "", jd_analysis=REALISTIC_JD_ANALYSIS)
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "pass"
        assert "no parseable project entries" in gate["detail"].lower()

    def test_scoring_uses_title_and_first_bullet_only_not_later_bullets(self):
        # _gate_project_relevance's text_blob is title_line + bullets[:1] —
        # a project whose ONLY on-topic content is its second bullet still
        # reads as off-topic. Pins this as current behaviour.
        cv = """## Projects
### Backyard Vegetable Garden Planner
*Notion | 2021*
- Sketched a seasonal planting rotation for a home garden.
- Analysed soil pH data with Python and SQL.
"""
        report = run_tailored_structural_validation(cv, "", jd_analysis=REALISTIC_JD_ANALYSIS)
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "warn", gate["detail"]

    def test_KNOWN_EDGE_CASE_double_starred_subline_is_folded_into_the_preceding_entry(self):
        # subtitle_re in parsing._parse_entries requires a single italic
        # span with no inner "*" — a subline containing its own bold run
        # ("**Docker**") breaks that regex, so _parse_entries emits it as
        # its own title_line entry instead of absorbing it. The gate's own
        # merge step (is_italic_subline check) folds it back into the
        # preceding entry as long as that entry has no bullets yet, so the
        # net effect is still one scored project, not two.
        cv = """## Projects
### Sales Dashboard | github.com/example/dashboard
*Python, **Docker** | 2022*
- Built a Tableau dashboard on top of a SQL data warehouse.
"""
        report = run_tailored_structural_validation(cv, "", jd_analysis=REALISTIC_JD_ANALYSIS)
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "pass", gate["detail"]
        assert "1 project" in gate["detail"]

    def test_multiple_off_topic_projects_are_all_named_in_the_detail(self):
        cv = """## Projects
### Backyard Vegetable Garden Planner
*Notion | 2021*
- Sketched a seasonal planting rotation for a home garden.

### Watercolour Portrait Series
*Paper, paint | 2020*
- Painted a series of watercolour portraits.
"""
        report = run_tailored_structural_validation(cv, "", jd_analysis=REALISTIC_JD_ANALYSIS)
        gate = _gate(report, "project_relevance")
        assert gate["status"] == "warn"
        assert "2 project" in gate["detail"]
        assert "Backyard Vegetable Garden Planner" in gate["detail"]
        assert "Watercolour Portrait Series" in gate["detail"]
