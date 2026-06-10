"""Regression tests for the multi-loophole fix batch.

Covers:
  • 2A — match_evidence verification demotion
  • 4A — deterministic ATS experience score
  • 4B — tightened formatting score
  • 5A — bridge gating for HOME / NDIS / LIFESTYLE / THEATRE
  • 6A — unknown phrase tracker
"""
from __future__ import annotations

import json
import os
import tempfile

import pytest

from app.services.eval.writers import (
    _apply_setting_bridge,
    _cv_has_home_care_experience,
    _cv_has_lifestyle_experience,
    _cv_has_ndis_experience,
    _cv_has_theatre_experience,
    _SETTING_HOME,
    _SETTING_HOSPITAL,
    _SETTING_LIFESTYLE,
    _SETTING_NDIS,
    _SETTING_THEATRE,
)
from app.services.pipeline.steps.ats_scoring import (
    _experience_score,
    _formatting_score,
    run_ats_scoring,
)
from app.services.pipeline.steps.cv_jd_matching import (
    _BUCKETS,
    _CATEGORIES,
    _verify_match_evidence,
)
from app.services.skills.unknown_tracker import (
    record_unknown_phrases,
    summarise_log,
)


def _empty_block():
    return {b: {c: [] for c in _CATEGORIES} for b in _BUCKETS}


# ---------------------------------------------------------------------------
# 2A — match_evidence verification
# ---------------------------------------------------------------------------


class TestVerifyMatchEvidence:
    def test_demotes_when_quoted_evidence_not_in_cv(self):
        matched = _empty_block()
        missed = _empty_block()
        matched["required"]["soft_skills"] = ["leadership"]
        cv = "Worked as a junior individual contributor on dashboards."
        evidence = {"leadership": "led a team of five engineers across two projects"}

        demoted = _verify_match_evidence(matched, missed, evidence, cv)

        assert demoted == ["leadership"]
        assert "leadership" not in matched["required"]["soft_skills"]
        assert "leadership" in missed["required"]["soft_skills"]

    def test_keeps_when_evidence_appears_in_cv(self):
        matched = _empty_block()
        missed = _empty_block()
        matched["required"]["soft_skills"] = ["communication"]
        cv = "Strong verbal communication with stakeholders across business units."
        evidence = {"communication": "Strong verbal communication with stakeholders"}

        demoted = _verify_match_evidence(matched, missed, evidence, cv)

        assert demoted == []
        assert "communication" in matched["required"]["soft_skills"]

    def test_skips_when_no_evidence_quoted(self):
        matched = _empty_block()
        missed = _empty_block()
        matched["required"]["soft_skills"] = ["teamwork"]
        evidence = {}  # AI provided no quote — can't verify
        cv = "Solo developer."

        demoted = _verify_match_evidence(matched, missed, evidence, cv)
        assert demoted == []
        assert "teamwork" in matched["required"]["soft_skills"]

    def test_skips_short_evidence(self):
        """Short quotes (< 4 chars) are skipped to avoid false demotions on abbrevs."""
        matched = _empty_block()
        missed = _empty_block()
        matched["required"]["technical"] = ["sql"]
        evidence = {"sql": "QL"}  # too short to verify reliably
        cv = "Years of Python and Java work."

        demoted = _verify_match_evidence(matched, missed, evidence, cv)
        assert demoted == []

    def test_case_insensitive(self):
        matched = _empty_block()
        missed = _empty_block()
        matched["required"]["technical"] = ["python"]
        evidence = {"python": "PYTHON Scripting daily"}
        cv = "Python scripting daily for data pipelines."

        demoted = _verify_match_evidence(matched, missed, evidence, cv)
        assert demoted == []

    def test_mixed_case_evidence_keys(self):
        """AI may emit match_evidence with original-case keys ('Python': '...')
        while matched is already lowercased. Helper must normalise keys so the
        lookup doesn't silently miss → false 'verified' result."""
        matched = _empty_block()
        missed = _empty_block()
        matched["required"]["soft_skills"] = ["leadership"]
        # AI emits the key as "Leadership" (original case from the JD)
        evidence = {"Leadership": "led a team of five engineers across two projects"}
        cv = "Worked as a junior individual contributor on dashboards."

        demoted = _verify_match_evidence(matched, missed, evidence, cv)
        # Should demote — without key normalisation the lookup misses and the
        # bogus match survives.
        assert demoted == ["leadership"]
        assert "leadership" in missed["required"]["soft_skills"]


# ---------------------------------------------------------------------------
# 4A — deterministic experience score
# ---------------------------------------------------------------------------


class TestExperienceScore:
    def _matching(self, req_match, req_total, matched_resp=0, resp_total=0):
        per_cat = {
            "technical":        {"matched": 0, "total": 0},
            "soft_skills":      {"matched": 0, "total": 0},
            "domain_knowledge": {"matched": req_match, "total": req_total},
        }
        return {
            "counts": {"required": per_cat, "preferred": {}, "totals": {}},
            "matched_responsibilities": ["x"] * matched_resp,
        }

    def _jd(self, family="nursing", resp_total=0):
        return {
            "role_family": family,
            "responsibilities": ["r"] * resp_total,
        }

    def test_perfect_match_full_marks(self):
        m = self._matching(8, 8, matched_resp=4, resp_total=4)
        score = _experience_score(m, self._jd(resp_total=4))
        # 15 (≥80% match) + 12 (75%+ resp coverage) + 8 (nursing family) = 35
        assert score == 35

    def test_zero_match_minimal_marks(self):
        m = self._matching(0, 8, matched_resp=0, resp_total=4)
        score = _experience_score(m, self._jd(resp_total=4))
        # 0 (req) + 0 (resp) + 8 (family aligned) = 8
        assert score == 8

    def test_partial_match(self):
        m = self._matching(5, 8, matched_resp=2, resp_total=4)
        score = _experience_score(m, self._jd(resp_total=4))
        # 10 (60-79%) + 8 (≥50% resp) + 8 (nursing) = 26
        assert score == 26

    def test_master_family_half_credit_on_alignment(self):
        m = self._matching(8, 8, matched_resp=4, resp_total=4)
        score = _experience_score(m, self._jd(family="master", resp_total=4))
        # 15 + 12 + 4 = 31
        assert score == 31

    def test_no_jd_responsibilities_gives_neutral_half(self):
        m = self._matching(8, 8, matched_resp=0, resp_total=0)
        score = _experience_score(m, self._jd(resp_total=0))
        # 15 + 6 (neutral half) + 8 = 29
        assert score == 29

    def test_no_jd_required_keywords_neutral_half(self):
        m = self._matching(0, 0, matched_resp=4, resp_total=4)
        score = _experience_score(m, self._jd(resp_total=4))
        # 7.5 (neutral half) + 12 + 8 = 27.5
        assert score == 27.5

    def test_deterministic_across_calls(self):
        """Same inputs → identical scores. The whole point of removing the
        AI's raw_match_score is to eliminate this variance."""
        m = self._matching(6, 8, matched_resp=3, resp_total=5)
        jd = self._jd(resp_total=5)
        scores = [_experience_score(m, jd) for _ in range(10)]
        assert len(set(scores)) == 1


# ---------------------------------------------------------------------------
# 4B — formatting score tightening
# ---------------------------------------------------------------------------


class TestFormattingScoreTightening:
    def test_section_word_in_sentence_does_not_award_points(self):
        """The OLD bug: 'experience' in any sentence gave the section the points.
        The NEW check requires the word as a heading line."""
        cv = (
            "I have lots of experience and education and skills. "
            "Email: x@y.com. Phone: +61 412 345 678."
        )
        score = _formatting_score(cv)
        # ~30 (contact) + 0 (no real headings) + 5 (short, ~17 words) = ~35/100 → ~5.25/15
        assert score < 8.0

    def test_real_headings_award_points(self):
        cv = (
            "John Doe\nEmail: x@y.com  Phone: +61 412 345 678\n\n"
            "## Experience\n- xyz\n\n## Education\n- xyz\n\n## Skills\n- xyz\n"
        )
        score = _formatting_score(cv)
        # 30 (contact) + 60 (all three headings) + something (length) → ≥90/100 → ≥13.5/15
        assert score >= 13.0

    def test_short_phone_not_credited(self):
        """8-digit run (old floor) should NOT count as a phone now."""
        cv = "Email is x@y.com. Reference number 12345678."  # no real phone
        score = _formatting_score(cv)
        # Should NOT get the phone-or-url 15 points beyond email.
        # 15 (email only) + 0 (no headings) + 5 (short) → 20/100 → ~3/15
        assert score < 6.0

    def test_nursing_length_window_broadened(self):
        """Nursing CVs with credentials lists routinely hit 1500-2500 words.
        The old window capped at 1500 = half-credit; new caps at 2500."""
        words = ["word"] * 2000
        cv = "Email: x@y.com\nPhone: +61 412 345 678\n\n## Experience\n" + " ".join(words)
        score = _formatting_score(cv)
        # 30 + 20 + 10 = 60/100 → 9.0/15
        assert score >= 9.0


# ---------------------------------------------------------------------------
# 5A — Bridge gating
# ---------------------------------------------------------------------------


_RESIDENTIAL_S1 = (
    "## Career Highlights\n\n"
    "Care worker with experience in residential aged care settings, "
    "specialising in dementia care. Recent experience at Org A.\n\n"
    "## Experience\n\n"
    "### Org A | Sydney, NSW\n*AIN | Jan 2024 – Present*\n- Provided personal care.\n"
)


class TestBridgeGating:
    def test_home_bridge_skipped_when_cv_has_no_home_evidence(self):
        out = _apply_setting_bridge(
            _RESIDENTIAL_S1, _SETTING_HOME, cv_text=_RESIDENTIAL_S1,
        )
        assert "home and community settings" not in out

    def test_home_bridge_applied_when_cv_has_home_evidence(self):
        cv = _RESIDENTIAL_S1 + "Also delivered home care visits to clients in the community.\n"
        md = _RESIDENTIAL_S1 + "Also delivered home care visits to clients in the community.\n"
        out = _apply_setting_bridge(md, _SETTING_HOME, cv_text=cv)
        assert "home and community settings" in out

    def test_ndis_bridge_skipped_without_evidence(self):
        out = _apply_setting_bridge(
            _RESIDENTIAL_S1, _SETTING_NDIS, cv_text=_RESIDENTIAL_S1,
        )
        assert "disability support" not in out.lower()

    def test_ndis_bridge_applied_with_evidence(self):
        cv = _RESIDENTIAL_S1 + "Worked with NDIS participants providing disability support.\n"
        md = _RESIDENTIAL_S1 + "Worked with NDIS participants providing disability support.\n"
        out = _apply_setting_bridge(md, _SETTING_NDIS, cv_text=cv)
        assert "disability support" in out.lower()

    def test_theatre_bridge_skipped_without_evidence(self):
        out = _apply_setting_bridge(
            _RESIDENTIAL_S1, _SETTING_THEATRE, cv_text=_RESIDENTIAL_S1,
        )
        # Bridge phrase "aged care and healthcare settings" not added
        assert "healthcare settings" not in out

    def test_theatre_bridge_applied_with_evidence(self):
        cv = _RESIDENTIAL_S1 + "Perioperative experience in operating theatre.\n"
        md = _RESIDENTIAL_S1 + "Perioperative experience in operating theatre.\n"
        out = _apply_setting_bridge(md, _SETTING_THEATRE, cv_text=cv)
        assert "healthcare settings" in out

    def test_hospital_bridge_still_gated(self):
        """Sanity: the original hospital gate still works."""
        out = _apply_setting_bridge(
            _RESIDENTIAL_S1, _SETTING_HOSPITAL, cv_text=_RESIDENTIAL_S1,
        )
        assert "acute clinical settings" not in out


class TestEvidenceDetectors:
    def test_home_markers(self):
        assert _cv_has_home_care_experience(
            "## Experience\nDelivered home care visits.", "",
        )
        assert not _cv_has_home_care_experience(
            "## Experience\nResidential aged care only.", "",
        )

    def test_ndis_markers(self):
        assert _cv_has_ndis_experience(
            "## Experience\nNDIS support worker role.", "",
        )
        assert not _cv_has_ndis_experience(
            "## Experience\nResidential aged care only.", "",
        )

    def test_lifestyle_markers(self):
        assert _cv_has_lifestyle_experience(
            "## Experience\nLifestyle Coordinator running activities.", "",
        )
        assert not _cv_has_lifestyle_experience(
            "## Experience\nGeneral AIN duties.", "",
        )

    def test_theatre_markers(self):
        assert _cv_has_theatre_experience(
            "## Experience\nPerioperative scrub nurse.", "",
        )
        assert not _cv_has_theatre_experience(
            "## Experience\nResidential aged care only.", "",
        )

    def test_evidence_in_summary_only_does_not_count(self):
        """Summary-only markers shouldn't pass the gate — the writer could
        be paraphrasing the JD setting in S1."""
        md = "## Professional Summary\nNurse with home care experience.\n\n## Experience\nResidential only."
        # The marker IS present, but only in the summary; experience section
        # has no home markers. The scan slices to '## experience' onwards.
        assert not _cv_has_home_care_experience("", md)


# ---------------------------------------------------------------------------
# 6A — Unknown phrase tracker
# ---------------------------------------------------------------------------


class TestUnknownTracker:
    def _tmp(self):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        os.remove(path)  # we want the recorder to create it
        return path

    def test_records_unknowns(self):
        path = self._tmp()
        try:
            meta = {
                "required": {
                    "unknown": [
                        {"phrase": "xyz protocol", "category": "domain_knowledge"},
                        {"phrase": "qrs handling", "category": "technical"},
                    ],
                },
                "preferred": {"unknown": []},
            }
            n = record_unknown_phrases(
                role_family_id="nursing",
                job_title="AIN",
                lexicon_meta=meta,
                timestamp="2026-06-11T00:00:00",
                path=path,
            )
            assert n == 2
            with open(path) as fh:
                lines = [json.loads(l) for l in fh]
            assert {l["phrase"] for l in lines} == {"xyz protocol", "qrs handling"}
            assert all(l["role_family"] == "nursing" for l in lines)
        finally:
            if os.path.exists(path):
                os.remove(path)

    def test_no_unknowns_noop(self):
        path = self._tmp()
        try:
            meta = {"required": {"unknown": []}, "preferred": {"unknown": []}}
            n = record_unknown_phrases(
                role_family_id="tech",
                job_title="SWE",
                lexicon_meta=meta,
                timestamp="2026-06-11T00:00:00",
                path=path,
            )
            assert n == 0
            assert not os.path.exists(path)
        finally:
            if os.path.exists(path):
                os.remove(path)

    def test_missing_meta_noop(self):
        path = self._tmp()
        n = record_unknown_phrases(
            role_family_id="nursing",
            job_title=None,
            lexicon_meta=None,
            timestamp="2026-06-11T00:00:00",
            path=path,
        )
        assert n == 0
        assert not os.path.exists(path)

    def test_summarise_groups_and_ranks(self):
        path = self._tmp()
        try:
            # Record the same phrase 3 times and another twice.
            for _ in range(3):
                record_unknown_phrases(
                    role_family_id="nursing",
                    job_title="AIN",
                    lexicon_meta={"required": {"unknown": [
                        {"phrase": "spinal precautions", "category": "domain_knowledge"},
                    ]}, "preferred": {"unknown": []}},
                    timestamp="2026-06-11T00:00:00",
                    path=path,
                )
            for _ in range(2):
                record_unknown_phrases(
                    role_family_id="nursing",
                    job_title="EN",
                    lexicon_meta={"required": {"unknown": [
                        {"phrase": "syringe driver", "category": "technical"},
                    ]}, "preferred": {"unknown": []}},
                    timestamp="2026-06-11T00:00:00",
                    path=path,
                )
            ranked = summarise_log(path=path, top_n=10)
            assert ranked[0]["phrase"] == "spinal precautions"
            assert ranked[0]["count"] == 3
            assert ranked[1]["phrase"] == "syringe driver"
            assert ranked[1]["count"] == 2
            assert ranked[0]["role_families"] == ["nursing"]
        finally:
            if os.path.exists(path):
                os.remove(path)


# ---------------------------------------------------------------------------
# Integration sanity — full ATS pipeline still produces a valid response
# ---------------------------------------------------------------------------


def test_run_ats_scoring_integration():
    """End-to-end smoke: the rework keeps the API contract intact."""
    cv = (
        "Jane Doe\nEmail: jane@example.com  Phone: +61 412 345 678\n\n"
        "## Experience\n### Org A | Sydney\n*AIN | 2023-Present*\n- Provided personal care.\n\n"
        "## Education\n### TAFE\n*Cert III in Aged Care | 2022*\n\n"
        "## Skills\n- Personal care\n- Empathy\n"
    )
    jd_analysis = {
        "role_family": "nursing",
        "responsibilities": ["provide personal care", "support residents"],
        "required_skills": {
            "technical": [], "soft_skills": ["empathy"],
            "domain_knowledge": ["personal care", "aged care"],
        },
        "preferred_skills": {
            "technical": [], "soft_skills": [], "domain_knowledge": [],
        },
    }
    matching = {
        "counts": {
            "required": {
                "technical": {"matched": 0, "total": 0},
                "soft_skills": {"matched": 1, "total": 1},
                "domain_knowledge": {"matched": 2, "total": 2},
            },
            "preferred": {
                "technical": {"matched": 0, "total": 0},
                "soft_skills": {"matched": 0, "total": 0},
                "domain_knowledge": {"matched": 0, "total": 0},
            },
            "totals": {"matched": 3, "total": 3},
        },
        "match_rates": {},
        "matched_responsibilities": ["provide personal care", "support residents"],
        # raw_match_score intentionally omitted — proves we no longer depend on it.
    }
    result = run_ats_scoring(cv, jd_analysis, matching)

    assert "overall_score" in result
    assert 0 <= result["overall_score"] <= 100
    breakdown = result["breakdown"]
    assert breakdown["category_2_experience"]["source"].startswith("deterministic:")
    # Deterministic on same inputs.
    again = run_ats_scoring(cv, jd_analysis, matching)
    assert again["overall_score"] == result["overall_score"]
