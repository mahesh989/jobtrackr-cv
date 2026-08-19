"""Coverage gap (audit, execution chunk C42b): tailored_structural_validation/
gates_prose.py — 5 gates policing the Career Highlights section — had zero
test coverage. This is the highest fabrication-adjacency module in the
C42 split: `_gate_seniority_literal_match` and `_gate_highlights_reference_check`
are honesty-signal gates in the same family as this repo's `honesty_guard`
work (they flag content in the Highlights that isn't backed by the rest of
the CV), so these are worth the same characterization rigor as C42a's
foundation-layer tests.

All gates in this module are advisory (warn/pass, mostly never hard-fail
except profile_word_count/highlights_no_bullets/highlights_prose_shape) —
per the package's own docstring, the report never blocks or alters CV
delivery. Tests assert exact `status` + meaningful `detail` content.
"""
from __future__ import annotations

from app.services.pipeline.steps.tailored_structural_validation.gates_prose import (
    _gate_profile_word_count,
    _gate_seniority_literal_match,
    _gate_highlights_no_bullets,
    _gate_highlights_prose_shape,
    _gate_highlights_reference_check,
)


def _words(n: int) -> str:
    return " ".join(["word"] * n)


# ---------------------------------------------------------------------------
# _gate_profile_word_count
# ---------------------------------------------------------------------------


class TestGateProfileWordCount:
    def test_no_profile_section_fails(self):
        result = _gate_profile_word_count({})
        assert result["status"] == "fail"
        assert "No ## Career Highlights" in result["detail"]

    def test_under_25_words_fails_as_too_thin(self):
        result = _gate_profile_word_count({"career highlights": _words(10)})
        assert result["status"] == "fail"
        assert "far too thin" in result["detail"]

    def test_25_to_34_words_warns(self):
        result = _gate_profile_word_count({"career highlights": _words(30)})
        assert result["status"] == "warn"
        assert "target 35-50" in result["detail"]

    def test_35_to_50_words_passes(self):
        result = _gate_profile_word_count({"career highlights": _words(40)})
        assert result["status"] == "pass"

    def test_51_to_65_words_warns_as_padded(self):
        result = _gate_profile_word_count({"career highlights": _words(55)})
        assert result["status"] == "warn"
        assert "padded" in result["detail"]

    def test_over_65_words_fails_as_absolute_max_exceeded(self):
        result = _gate_profile_word_count({"career highlights": _words(70)})
        assert result["status"] == "fail"
        assert "absolute max 65" in result["detail"]

    def test_boundary_exactly_35_words_passes(self):
        assert _gate_profile_word_count({"career highlights": _words(35)})["status"] == "pass"

    def test_boundary_exactly_50_words_passes(self):
        assert _gate_profile_word_count({"career highlights": _words(50)})["status"] == "pass"

    def test_alias_highlights_alone_also_resolves(self):
        result = _gate_profile_word_count({"highlights": _words(40)})
        assert result["status"] == "pass"


# ---------------------------------------------------------------------------
# _gate_seniority_literal_match
# ---------------------------------------------------------------------------


class TestGateSeniorityLiteralMatch:
    def test_no_profile_section_warns(self):
        result = _gate_seniority_literal_match({}, "some cv text")
        assert result["status"] == "warn"
        assert "No Profile section" in result["detail"]

    def test_seniority_word_in_profile_and_in_cv_passes(self):
        sections = {"career highlights": "Senior Registered Nurse with broad experience."}
        cv = "Worked as a Senior Nurse at General Hospital."
        result = _gate_seniority_literal_match(sections, cv)
        assert result["status"] == "pass"

    def test_seniority_word_in_profile_but_absent_from_cv_warns(self):
        sections = {"career highlights": "Senior Registered Nurse with broad experience."}
        cv = "Worked as a Registered Nurse at General Hospital."
        result = _gate_seniority_literal_match(sections, cv)
        assert result["status"] == "warn"
        assert "senior" in result["detail"]
        assert "verify the seniority claim" in result["detail"]

    def test_multiple_unverified_seniority_words_all_flagged(self):
        sections = {"career highlights": "Lead and Principal engineer with deep expertise."}
        cv = "Worked as a Software Engineer."
        result = _gate_seniority_literal_match(sections, cv)
        assert result["status"] == "warn"
        assert "lead" in result["detail"]
        assert "principal" in result["detail"]

    def test_no_seniority_words_at_all_passes(self):
        sections = {"career highlights": "Registered Nurse with broad clinical experience."}
        result = _gate_seniority_literal_match(sections, "Some unrelated CV text.")
        assert result["status"] == "pass"

    def test_word_boundary_prevents_substring_false_positive(self):
        # "leader" contains "lead" as a substring but is a different word —
        # \b...\b anchoring must not treat it as the seniority token "lead".
        sections = {"career highlights": "Team leader with strong collaboration skills."}
        result = _gate_seniority_literal_match(sections, "Unrelated CV text with no matches.")
        assert result["status"] == "pass"

    def test_case_insensitive_matching(self):
        sections = {"career highlights": "SENIOR nurse with experience."}
        cv = "Worked as a senior nurse."
        result = _gate_seniority_literal_match(sections, cv)
        assert result["status"] == "pass"

    def test_empty_original_cv_text_still_handled_gracefully(self):
        sections = {"career highlights": "Senior nurse with experience."}
        result = _gate_seniority_literal_match(sections, "")
        assert result["status"] == "warn"

    def test_none_original_cv_text_does_not_raise(self):
        sections = {"career highlights": "Senior nurse with experience."}
        result = _gate_seniority_literal_match(sections, None)
        assert result["status"] == "warn"


# ---------------------------------------------------------------------------
# _gate_highlights_no_bullets
# ---------------------------------------------------------------------------


class TestGateHighlightsNoBullets:
    def test_no_section_warns(self):
        result = _gate_highlights_no_bullets({})
        assert result["status"] == "warn"

    def test_prose_only_passes(self):
        sections = {"career highlights": "Registered Nurse with broad clinical experience. Skilled in wound care."}
        result = _gate_highlights_no_bullets(sections)
        assert result["status"] == "pass"

    def test_dash_bullet_fails(self):
        sections = {"career highlights": "Prose line.\n- A bullet point.\n"}
        result = _gate_highlights_no_bullets(sections)
        assert result["status"] == "fail"
        assert "1 bullet point" in result["detail"]

    def test_multiple_bullet_styles_all_counted(self):
        sections = {"career highlights": "- Dash\n• Bullet char\n* Asterisk\n"}
        result = _gate_highlights_no_bullets(sections)
        assert result["status"] == "fail"
        assert "3 bullet point" in result["detail"]


# ---------------------------------------------------------------------------
# _gate_highlights_prose_shape
# ---------------------------------------------------------------------------


class TestGateHighlightsProseShape:
    def test_no_section_warns(self):
        result = _gate_highlights_prose_shape({})
        assert result["status"] == "warn"

    def test_exactly_two_sentences_passes(self):
        body = (
            "Registered Nurse with five years experience. "
            "Skilled in wound care and medication management."
        )
        result = _gate_highlights_prose_shape({"career highlights": body})
        assert result["status"] == "pass"

    def test_one_sentence_fails(self):
        body = "Registered Nurse with five years experience in aged care and community settings today."
        result = _gate_highlights_prose_shape({"career highlights": body})
        assert result["status"] == "fail"
        assert "Only 1 sentence" in result["detail"]

    def test_three_sentences_fails(self):
        body = "First sentence here. Second sentence here. Third sentence here."
        result = _gate_highlights_prose_shape({"career highlights": body})
        assert result["status"] == "fail"
        assert "3 sentences detected" in result["detail"]

    def test_skills_line_is_flagged_and_stripped_before_sentence_count(self):
        body = (
            "Registered Nurse with five years experience. "
            "Skilled in wound care and medication management.\n"
            "*Skills: Wound Care, Medication Management*\n"
        )
        result = _gate_highlights_prose_shape({"career highlights": body})
        assert result["status"] == "fail"
        assert "Skills:" in result["detail"]

    def test_abbreviations_do_not_get_miscounted_as_sentence_boundaries(self):
        # "Dr." should not be treated as a sentence terminator.
        body = (
            "Worked under Dr. Smith managing patient care daily. "
            "Delivered consistent high-quality outcomes for residents."
        )
        result = _gate_highlights_prose_shape({"career highlights": body})
        assert result["status"] == "pass"


# ---------------------------------------------------------------------------
# _gate_highlights_reference_check
# ---------------------------------------------------------------------------


class TestGateHighlightsReferenceCheck:
    def test_no_profile_section_warns(self):
        result = _gate_highlights_reference_check({})
        assert result["status"] == "warn"

    def test_no_proper_noun_candidates_passes(self):
        sections = {"career highlights": "experienced worker with strong communication skills."}
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_multiword_capitalised_phrase_present_in_body_passes(self):
        sections = {
            "career highlights": "Experienced in Power BI dashboard development.",
            "skills": "Power BI, SQL, Python",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_multiword_capitalised_phrase_absent_from_body_fails_as_ghost(self):
        sections = {
            "career highlights": "Experienced in Power BI dashboard development.",
            "skills": "SQL, Python",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "fail"
        assert "Power BI" in result["detail"]

    def test_acronym_present_in_body_passes(self):
        sections = {
            "career highlights": "Deployed workloads on AWS infrastructure.",
            "skills": "AWS, Docker",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_acronym_absent_from_body_fails(self):
        sections = {
            "career highlights": "Deployed workloads on AWS infrastructure.",
            "skills": "Docker",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "fail"
        assert "AWS" in result["detail"]

    def test_stopcaps_words_are_never_flagged_even_when_absent_from_body(self):
        sections = {
            "career highlights": "Compassionate Care Support Worker with community experience.",
            "skills": "Unrelated skill only",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_award_in_awards_section_is_not_a_false_ghost(self):
        # Regression-shape guard: the gate scans family-specific sections
        # (awards/registration) specifically so a nursing CV's award,
        # cited in Highlights, isn't wrongly flagged just because it lives
        # in ## Awards rather than ## Experience.
        sections = {
            "career highlights": "Recipient of the Staff Excellence Award for outstanding care.",
            "awards": "Staff Excellence Award, Jesmond Miranda Nursing Home (2025)",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_registration_credential_referenced_in_highlights_is_not_a_false_ghost(self):
        sections = {
            "career highlights": "Holder of current AHPRA registration.",
            "registration & licences": "AHPRA Registration (RN) - current",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_slash_joined_tech_token_present_passes(self):
        sections = {
            "career highlights": "Built cross-platform apps using Flutter/Dart.",
            "skills": "Flutter/Dart, Firebase",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "pass"

    def test_duplicate_candidates_deduped_in_missing_list(self):
        # Note: multi_re is greedy across capitalised runs, so "Used Power
        # BI" (capitalised "Used" + "Power" + "BI") is captured as ONE
        # 3-word candidate distinct from a later bare "Power BI" — dedup is
        # by exact lowercased string, not by substring overlap. Repeat the
        # identical phrase verbatim to actually exercise the dedup path.
        sections = {
            "career highlights": "Central to Power BI development. Power BI was central to the role.",
            "skills": "SQL only",
        }
        result = _gate_highlights_reference_check(sections)
        assert result["status"] == "fail"
        # "Power BI" appears twice verbatim in the source text but must be
        # reported once in the missing list.
        assert result["detail"].count("Power BI") == 1
