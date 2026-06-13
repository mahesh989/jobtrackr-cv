"""Phase 1 — groundedness gate (verify_skill_evidence) tests.

The gate drops LLM-extracted skills whose ``evidence`` quote does not
appear in the JD body, or whose skill cannot be derived from that quote.
"""
from __future__ import annotations

import pytest

from app.services.skills import verify_skill_evidence


_NURSING_JD = (
    "Nursing Assistant (AIN) - Night Duty\n"
    "About the role\n"
    "You will be responsible for providing safe and holistic care for our residents. "
    "For example, nursing and emotional care, food handling and feeding.\n"
    "Working with the wider team to support residents' activities "
    "(e.g mobility and meaningful recreational activities)\n"
    "Excellent communication skills, both verbal and written. "
    "Enjoys working in partnership with residents and their family. "
    "Positive attitude and works well as part of a team."
)


def _ja(required, preferred=None, evidence=None):
    """Helper to build a jd_analysis with the v2 evidence shape."""
    return {
        "required_skills": required,
        "preferred_skills": preferred or {
            "technical": [], "soft_skills": [], "domain_knowledge": []
        },
        "skill_evidence": evidence or {},
    }


class TestGroundedSkillsAreKept:
    def test_direct_quote_in_jd_is_kept(self):
        ja = _ja(
            required={
                "technical": [],
                "soft_skills": ["verbal communication"],
                "domain_knowledge": [],
            },
            evidence={"verbal communication": "communication skills, both verbal and written"},
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert "verbal communication" in out["required_skills"]["soft_skills"]
        assert not (out.get("lexicon_meta") or {}).get("ungrounded")

    def test_token_overlap_keeps_skill_with_paraphrase_evidence(self):
        # "team" is a content token shared between skill and evidence.
        ja = _ja(
            required={
                "technical": [], "soft_skills": ["teamwork"], "domain_knowledge": [],
            },
            evidence={"teamwork": "works well as part of a team"},
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert "teamwork" in out["required_skills"]["soft_skills"]


class TestHallucinationsAreDropped:
    def test_skill_without_evidence_is_dropped(self):
        ja = _ja(
            required={
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": ["person-centred care"],
            },
            evidence={"person-centred care": ""},  # AI returned no quote
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert out["required_skills"]["domain_knowledge"] == []
        meta = out["lexicon_meta"]
        assert meta["ungrounded"][0]["reason"] == "no_evidence"

    def test_skill_with_evidence_not_in_jd_is_dropped(self):
        # Classic hallucination shape: LLM cites a quote the JD never said.
        ja = _ja(
            required={
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": ["person-centred care"],
            },
            evidence={"person-centred care": "We provide person-centred dementia care"},
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert out["required_skills"]["domain_knowledge"] == []
        assert out["lexicon_meta"]["ungrounded"][0]["reason"] == "evidence_not_in_jd"

    def test_skill_not_derivable_from_evidence_is_dropped(self):
        # Evidence is genuinely from the JD but doesn't support the skill.
        ja = _ja(
            required={
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": ["stakeholder management"],
            },
            evidence={"stakeholder management": "providing safe and holistic care for our residents"},
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert out["required_skills"]["domain_knowledge"] == []
        assert out["lexicon_meta"]["ungrounded"][0]["reason"] == "skill_not_derivable"


class TestBackCompat:
    def test_missing_evidence_map_is_noop(self):
        ja = {
            "required_skills": {
                "technical": ["python"], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            # No skill_evidence key at all — older AI output.
        }
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert out["required_skills"]["technical"] == ["python"]
        assert "ungrounded" not in (out.get("lexicon_meta") or {})

    def test_empty_evidence_map_is_noop(self):
        ja = _ja(
            required={"technical": ["python"], "soft_skills": [], "domain_knowledge": []},
            evidence={},
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert out["required_skills"]["technical"] == ["python"]


class TestUnicodeAndCasingTolerance:
    def test_unicode_dash_in_jd_matches_ascii_dash_in_evidence(self):
        jd = "We support residents — providing person-centred care every day."
        ja = _ja(
            required={
                "technical": [], "soft_skills": [], "domain_knowledge": ["person-centred care"],
            },
            evidence={"person-centred care": "providing person-centred care every day"},
        )
        out = verify_skill_evidence(ja, jd, role_family_id="nursing")
        assert "person-centred care" in out["required_skills"]["domain_knowledge"]

    def test_case_insensitive_evidence_match(self):
        ja = _ja(
            required={
                "technical": [], "soft_skills": ["teamwork"], "domain_knowledge": [],
            },
            evidence={"teamwork": "WORKS WELL AS PART OF A TEAM"},
        )
        out = verify_skill_evidence(ja, _NURSING_JD, role_family_id="nursing")
        assert "teamwork" in out["required_skills"]["soft_skills"]


class TestNursingHallucinationRegression:
    """Concrete reproduction of the Jesmond Group JD failure mode."""

    def test_person_centred_care_with_AIN_evidence_is_dropped(self):
        # The classic shape we observed in production: LLM cites the job
        # title abbreviation ("AIN") as evidence for a skill the JD body
        # never mentions.
        ja = _ja(
            required={
                "technical": [],
                "soft_skills": [],
                "domain_knowledge": [
                    "aged care",
                    "person-centred care",
                    "food handling",
                    "mobility support",
                ],
            },
            evidence={
                "aged care": "residential aged care",
                # Hallucinated — "AIN" appears in the JD title but it's not
                # evidence for person-centred care.
                "person-centred care": "Nursing Assistant (AIN)",
                "food handling": "food handling and feeding",
                "mobility support": "support residents' activities (e.g mobility",
            },
        )
        # JD shorter version where "AIN" exists but not "person-centred".
        jd = (
            "Nursing Assistant (AIN) Night Duty. "
            "Providing residential aged care. "
            "food handling and feeding. "
            "support residents' activities (e.g mobility and recreational activities)."
        )
        out = verify_skill_evidence(ja, jd, role_family_id="nursing")
        kept = out["required_skills"]["domain_knowledge"]
        assert "aged care" in kept
        assert "food handling" in kept
        assert "mobility support" in kept
        # The hallucination is dropped:
        assert "person-centred care" not in kept
        reasons = {u["skill"]: u["reason"] for u in out["lexicon_meta"]["ungrounded"]}
        assert reasons["person-centred care"] == "skill_not_derivable"
