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
    _FORMATTING_MAX,
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
from app.services.skills.post_process import demote_off_setting_keywords


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
# 4A — experience score (v1 tests removed)
# ---------------------------------------------------------------------------
#
# v1's three-sub-signal 35-pt formula (and its ``(matching, jd) -> float``
# signature) was replaced wholesale by v2. Coverage of every v2 sub-signal
# lives in ``tests/test_ats_scoring_v2.py``: role-family freebie removed,
# required-keyword double-count removed, tailoring invariant (Cat 2 + 3
# unmoved by keyword injection), and each sub-signal's formula in
# isolation. Nothing left to assert against v1 here.


# ---------------------------------------------------------------------------
# 4B — formatting score tightening
# ---------------------------------------------------------------------------


class TestFormattingScoreRealWorldCV:
    """Production regression (Rashmi's CV): the strict-anchor regex required
    headings to END a line ($), but PDF-extracted layouts often glue the
    heading word to the next bit of content on the same line. Real CVs were
    scoring 60% on formatting because only 1 of 3 sections matched. The
    loosened regex (line-start + word-boundary, no end-anchor) gives the
    real heading word its 20 points while still rejecting mid-sentence
    occurrences."""

    def test_pdf_extracted_heading_glued_to_content(self):
        cv = (
            "Rashmi Poudel\n"
            "NSW | 0403760681 | rashmipoudel756@gmail.com | LinkedIn\n"
            "\n"
            "Experience Uniting Leichhardt NSW Australia\n"
            "Assistant in Nursing (Casual) Mar 2026 - Present\n"
            "Provide person-centred care to residents...\n"
            "\n"
            "Education Heritage Skills Institute Arncliffe NSW\n"
            "Certificate IV in Ageing Support May 2025\n"
            "\n"
            "Skills Care Skills: Personal Care, Dementia Care\n"
            "More content to push the word count up to a reasonable range "
            "for the length sub-signal. " * 10
        )
        score = _formatting_score(cv)
        # Score thresholds expressed as a fraction of _FORMATTING_MAX so
        # the assertions survive future envelope changes (v1 was 15, v2 is 10).
        assert score >= 0.85 * _FORMATTING_MAX, f"Expected high formatting score, got {score}"

    def test_plain_markdown_heading_still_matches(self):
        cv = (
            "Name\nemail@x.com\nphone +61 412 345 678\n\n"
            "## Experience\nrole at company\n\n"
            "## Education\ndegree\n\n"
            "## Skills\nlist of skills\n"
        )
        score = _formatting_score(cv)
        assert score >= 0.85 * _FORMATTING_MAX

    def test_skills_variants_recognised(self):
        """Production regression (Rashmi Run 2): 2/3 sections matched -> 80%
        formatting. Likely culprit was a 'Skills' variant (Key/Core/Technical)
        that the strict regex missed."""
        variants = [
            "Key Skills", "Core Skills", "Technical Skills",
            "Soft Skills", "Care Skills", "Skills Summary",
            "Areas of Expertise", "Key Competencies",
        ]
        for v in variants:
            cv = (
                "Name\nemail@x.com\nphone +61 412 345 678\n\n"
                "## Experience\nrole\n\n## Education\ndegree\n\n"
                f"{v}\nlist of items here\n"
            )
            score = _formatting_score(cv)
            assert score >= 0.85 * _FORMATTING_MAX, f"variant '{v}' failed to match heading (score={score})"

    def test_education_variants_recognised(self):
        variants = [
            "Education", "Educational Background", "Academic Background",
            "Academic Qualifications", "Qualifications",
        ]
        for v in variants:
            cv = (
                "Name\nemail@x.com\nphone +61 412 345 678\n\n"
                "## Experience\nrole\n\n"
                f"{v}\ndegree info\n\n"
                "## Skills\nlist\n"
            )
            score = _formatting_score(cv)
            assert score >= 0.85 * _FORMATTING_MAX, f"variant '{v}' failed to match heading (score={score})"

    def test_experience_variants_recognised(self):
        variants = [
            "Experience", "Work Experience", "Professional Experience",
            "Employment History", "Work History", "Career Summary",
        ]
        for v in variants:
            cv = (
                "Name\nemail@x.com\nphone +61 412 345 678\n\n"
                f"{v}\nrole at company\n\n"
                "## Education\ndegree\n\n## Skills\nlist\n"
            )
            score = _formatting_score(cv)
            assert score >= 0.85 * _FORMATTING_MAX, f"variant '{v}' failed to match heading (score={score})"


class TestFormattingScoreTightening:
    def test_section_word_in_sentence_does_not_award_points(self):
        """The OLD bug: 'experience' in any sentence gave the section the points.
        The NEW check requires the word as a heading line."""
        cv = (
            "I have lots of experience and education and skills. "
            "Email: x@y.com. Phone: +61 412 345 678."
        )
        score = _formatting_score(cv)
        # Contact only + no real headings + short length → well below half.
        assert score < 0.55 * _FORMATTING_MAX

    def test_real_headings_award_points(self):
        cv = (
            "John Doe\nEmail: x@y.com  Phone: +61 412 345 678\n\n"
            "## Experience\n- xyz\n\n## Education\n- xyz\n\n## Skills\n- xyz\n"
        )
        score = _formatting_score(cv)
        # Full contact + all three section headings → high in the envelope.
        assert score >= 0.85 * _FORMATTING_MAX

    def test_short_phone_not_credited(self):
        """8-digit run (old floor) should NOT count as a phone now."""
        cv = "Email is x@y.com. Reference number 12345678."  # no real phone
        score = _formatting_score(cv)
        # Email only — no phone, no URL, no headings, very short length.
        assert score < 0.40 * _FORMATTING_MAX

    def test_nursing_length_window_broadened(self):
        """Nursing CVs with credentials lists routinely hit 1500-2500 words.
        The old window capped at 1500 = half-credit; new caps at 2500."""
        words = ["word"] * 2000
        cv = "Email: x@y.com\nPhone: +61 412 345 678\n\n## Experience\n" + " ".join(words)
        score = _formatting_score(cv)
        # Email + phone + one section heading + full length window credit.
        assert score >= 0.55 * _FORMATTING_MAX


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


class TestOffSettingDemotion:
    """Production regression (Australian Unity AIN, residential aged care):
    'disability support' leaked from the brand prose 'we support people
    across aged care, disability, and mental health services' into Required
    Care Skills, blowing up the required-match rate from 100% to 66.7%.
    The deterministic demoter moves off-setting domain keywords from
    required → preferred when the JD's classified setting is RESIDENTIAL."""

    def _jd(self, required_dk, preferred_dk=None):
        return {
            "job_title": "ain",
            "role_family": "nursing",
            "required_skills": {
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": list(required_dk),
            },
            "preferred_skills": {
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": list(preferred_dk or []),
            },
        }

    def test_disability_support_demoted_on_residential(self):
        jd = self._jd([
            "personal care", "aged care", "disability support", "individual support",
        ])
        out = demote_off_setting_keywords(jd, "residential")
        req = out["required_skills"]["domain_knowledge"]
        pref = out["preferred_skills"]["domain_knowledge"]
        assert "disability support" not in req
        assert "disability support" in pref
        # Real residential skills stay in required.
        assert "personal care" in req
        assert "aged care" in req
        assert "individual support" in req

    def test_mental_health_demoted_on_residential(self):
        jd = self._jd([
            "personal care", "mental health support",
        ])
        out = demote_off_setting_keywords(jd, "residential")
        assert "mental health support" not in out["required_skills"]["domain_knowledge"]
        assert "mental health support" in out["preferred_skills"]["domain_knowledge"]

    def test_home_care_demoted_on_residential(self):
        jd = self._jd(["home care", "personal care"])
        out = demote_off_setting_keywords(jd, "residential")
        assert "home care" not in out["required_skills"]["domain_knowledge"]
        assert "home care" in out["preferred_skills"]["domain_knowledge"]

    def test_no_demotion_on_home_setting(self):
        """Home-care JD: 'disability support' / 'mental health' should stay
        put — we only demote on RESIDENTIAL today. Conservative."""
        jd = self._jd(["disability support", "mental health support"])
        out = demote_off_setting_keywords(jd, "home_community")
        assert "disability support" in out["required_skills"]["domain_knowledge"]
        assert "mental health support" in out["required_skills"]["domain_knowledge"]

    def test_no_demotion_when_setting_is_none(self):
        jd = self._jd(["disability support", "personal care"])
        out = demote_off_setting_keywords(jd, None)
        assert out == jd  # untouched

    def test_no_double_add_when_already_preferred(self):
        """If disability_support is already in preferred, demoting from
        required should NOT duplicate it."""
        jd = self._jd(["disability support"], ["disability support"])
        out = demote_off_setting_keywords(jd, "residential")
        assert out["preferred_skills"]["domain_knowledge"].count("disability support") == 1
        assert "disability support" not in out["required_skills"]["domain_knowledge"]

    def test_demotion_recorded_in_lexicon_meta(self):
        jd = self._jd(["disability support", "personal care"])
        out = demote_off_setting_keywords(jd, "residential")
        assert "lexicon_meta" in out
        assert out["lexicon_meta"]["off_setting_demoted"]["setting"] == "residential"
        assert "disability support" in out["lexicon_meta"]["off_setting_demoted"]["demoted"]


class TestRescorerClassification:
    """Production regression (Marrickville Home Care Run 2): 4 keywords
    showed as 'Approved but missed' even though 2 of them were
    DELIBERATELY suppressed by the writer:
      • domestic assistance  — caught by _ROLE_CATEGORY_LABELS (sector
        descriptor; injected into bullets not Skills)
      • health and safety compliance — caught by _NON_SKILL_PATTERN
        via the \\bcompliance\\b alternative
    The rescorer's _is_sector_only_phrase didn't check either, so these
    looked like writer failures. Fixed by mirroring the full writer
    filter chain (EXACT + ROLE_LABELS + PREFIXES + PATTERN)."""

    def test_role_category_label_classified_as_filtered(self):
        from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
        tailored = "## Skills\n- **Care Skills:** Personal Care\n"
        plan = {"feasibility_plan": {
            "inject_directly": [],
            "inject_as_extension": [
                {"keyword": "domestic assistance", "category": "domain_knowledge",
                 "bucket": "required"},
            ],
            "inject_with_inference": [],
            "cannot_inject": [],
        }}
        jd = {"required_skills": {"technical": [], "soft_skills": [],
              "domain_knowledge": ["domestic assistance"]},
              "preferred_skills": {"technical": [], "soft_skills": [],
              "domain_knowledge": []}}
        matching = {"matched": {"required": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []},
                    "preferred": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []}},
                    "missed": {"required": {"technical": [], "soft_skills": [],
                    "domain_knowledge": ["domestic assistance"]},
                    "preferred": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []}},
                    "counts": {}, "match_rates": {},
                    "matched_responsibilities": [], "raw_match_score": 50}
        ats = {"overall_score": 50, "match_rates": {}}

        result = run_tailored_rescoring(tailored, jd, matching, plan, ats)
        assert "domestic assistance" in result["filtered_as_non_skill"]
        assert "domestic assistance" not in result["failed_to_inject"]

    def test_compliance_phrase_classified_as_filtered(self):
        from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
        tailored = "## Skills\n- **Care Skills:** Personal Care\n"
        plan = {"feasibility_plan": {
            "inject_directly": [
                {"keyword": "health and safety compliance",
                 "category": "domain_knowledge", "bucket": "required"},
            ],
            "inject_as_extension": [], "inject_with_inference": [],
            "cannot_inject": [],
        }}
        jd = {"required_skills": {"technical": [], "soft_skills": [],
              "domain_knowledge": ["health and safety compliance"]},
              "preferred_skills": {"technical": [], "soft_skills": [],
              "domain_knowledge": []}}
        matching = {"matched": {"required": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []},
                    "preferred": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []}},
                    "missed": {"required": {"technical": [], "soft_skills": [],
                    "domain_knowledge": ["health and safety compliance"]},
                    "preferred": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []}},
                    "counts": {}, "match_rates": {},
                    "matched_responsibilities": [], "raw_match_score": 50}
        ats = {"overall_score": 50, "match_rates": {}}

        result = run_tailored_rescoring(tailored, jd, matching, plan, ats)
        assert "health and safety compliance" in result["filtered_as_non_skill"]
        assert "health and safety compliance" not in result["failed_to_inject"]

    def test_genuinely_missed_still_in_failed(self):
        """Sanity: a keyword that PASSES all writer filters but doesn't
        literally appear in tailored md stays in 'failed' (Approved but
        missed). Without this, the bug fix would hide real writer issues."""
        from app.services.pipeline.steps.tailored_rescoring import run_tailored_rescoring
        tailored = "## Skills\n- **Care Skills:** Personal Care\n"
        plan = {"feasibility_plan": {
            "inject_directly": [
                {"keyword": "toileting assistance",
                 "category": "domain_knowledge", "bucket": "required"},
            ],
            "inject_as_extension": [], "inject_with_inference": [],
            "cannot_inject": [],
        }}
        jd = {"required_skills": {"technical": [], "soft_skills": [],
              "domain_knowledge": ["toileting assistance"]},
              "preferred_skills": {"technical": [], "soft_skills": [],
              "domain_knowledge": []}}
        matching = {"matched": {"required": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []},
                    "preferred": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []}},
                    "missed": {"required": {"technical": [], "soft_skills": [],
                    "domain_knowledge": ["toileting assistance"]},
                    "preferred": {"technical": [], "soft_skills": [],
                    "domain_knowledge": []}},
                    "counts": {}, "match_rates": {},
                    "matched_responsibilities": [], "raw_match_score": 50}
        ats = {"overall_score": 50, "match_rates": {}}

        result = run_tailored_rescoring(tailored, jd, matching, plan, ats)
        assert "toileting assistance" in result["failed_to_inject"]
        assert "toileting assistance" not in result["filtered_as_non_skill"]


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
    # v2 source: deterministic three-sub-signal experience.
    assert "v2 deterministic" in breakdown["category_2_experience"]["source"]
    assert "components" in breakdown["category_2_experience"]
    # Deterministic on same inputs.
    again = run_ats_scoring(cv, jd_analysis, matching)
    assert again["overall_score"] == result["overall_score"]
