"""Phase 2 — lexicon post-process integration.

Validates the JD-analysis + CV-categorisation post-pass against the
EXACT skill lists from the Hardi / Nepean nursing runs that motivated
this rewrite. If any of these assertions break, the leak is back.
"""
from __future__ import annotations

import pytest

from app.services.skills.post_process import (
    post_process_cv_skills,
    post_process_jd_analysis,
    post_process_skills,
)


# ---------------------------------------------------------------------------
# The Hardi JD — actual skills lists from the user's analysis paste
# ---------------------------------------------------------------------------


HARDI_JD_RAW = {
    "job_title": "assistant in nursing (ain)",
    "role_family": "nursing",
    "required_skills": {
        "technical": [
            "clinical assessments",
            "clinical observations",
            "wound management",
            "continence management",
            "resident charting and documentation",
            "computer skills",
            "writing skills",
        ],
        "soft_skills": [
            "effective verbal communication",
            "effective written communication",
            "organisation",
            "time management",
            "ability to work in a team",
            "ability to work autonomously",
            "empathetic nature",
            "tolerant nature",
            "patient nature",
            "duty of care mindset",
        ],
        "domain_knowledge": [
            "personal care for elderly residents",
            "risk management in care settings",
            "aged care policies and procedures",
        ],
    },
    "preferred_skills": {
        "technical": [],
        "soft_skills": [],
        "domain_knowledge": [
            "australian permanent residency or citizenship",
        ],
    },
}


class TestHardiJdPostProcess:

    @pytest.fixture(scope="class")
    def processed(self):
        return post_process_jd_analysis(HARDI_JD_RAW, role_family_id="nursing")

    def test_eligibility_dropped_from_preferred(self, processed):
        """`australian permanent residency or citizenship` was the only
        preferred CARE skill in the Hardi run. After post-process it
        must NOT be in skills and must be tagged as eligibility."""
        all_pref = []
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            all_pref.extend(processed["preferred_skills"][cat])
        assert "australian permanent residency or citizenship" not in [s.lower() for s in all_pref]
        assert "australian permanent residency or citizenship" in [
            s.lower() for s in processed["lexicon_meta"]["preferred"]["eligibility"]
        ]

    def test_personal_safety_and_aged_care_policies_dropped_as_noise(self, processed):
        """Two CARE skills in the Hardi raw are framework/noise phrases.
        Both must vanish from skills and be tagged as noise."""
        all_req = []
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            all_req.extend(s.lower() for s in processed["required_skills"][cat])
        # The raw had "risk management in care settings" and
        # "aged care policies and procedures" — both are noise.
        assert "risk management in care settings" not in all_req
        assert "aged care policies and procedures" not in all_req
        noise_list = [s.lower() for s in processed["lexicon_meta"]["required"]["noise"]]
        assert "risk management in care settings" in noise_list
        assert "aged care policies and procedures" in noise_list

    def test_clinical_skills_moved_from_technical_to_domain(self, processed):
        """The LLM put `wound management`, `continence management`,
        `clinical assessments`, `clinical observations`, `resident
        charting and documentation` in `technical` (→ would render as
        Other Skills for nursing). Lexicon must move them to
        domain_knowledge (→ Care Skills)."""
        dom = [s.lower() for s in processed["required_skills"]["domain_knowledge"]]
        tech = [s.lower() for s in processed["required_skills"]["technical"]]
        assert "wound care" in dom              # wound management → wound care
        assert "continence care" in dom         # continence management → continence care
        assert "clinical assessments" in dom
        assert "clinical observations" in dom
        assert "clinical documentation" in dom  # resident charting → clinical documentation
        # NONE of these should be left in technical
        for kw in ("wound care", "continence care", "clinical assessments",
                   "clinical observations", "clinical documentation",
                   "wound management", "continence management"):
            assert kw not in tech, f"{kw!r} should have moved out of technical"

    def test_other_skills_only_real_tech_skills(self, processed):
        """For nursing, `technical` (→ Other Skills line) must only hold
        genuine tools/software/computing. After the move-out of
        clinical items, the only survivors are `computer skills` and
        `writing skills` (kept where the LLM put them — they're soft
        skills semantically, but writing skills isn't in our lexicon
        as a canonical-bucket-correcting entry so it stays where LLM
        placed it)."""
        tech = processed["required_skills"]["technical"]
        # Whatever survives, it must NOT be a clinical skill or a noise/credential.
        forbidden = {
            "wound management", "wound care", "continence management",
            "continence care", "clinical assessments", "clinical observations",
            "resident charting", "resident charting and documentation",
            "clinical documentation", "australian permanent residency or citizenship",
            "personal safety and risk management",
        }
        for s in tech:
            assert s.lower() not in forbidden, f"junk leaked into technical: {s!r}"

    def test_soft_skills_canonicalised(self, processed):
        """Variants like `effective verbal communication`, `ability to
        work in a team` should resolve to canonical entries."""
        soft = [s.lower() for s in processed["required_skills"]["soft_skills"]]
        # `effective verbal communication` → canonical `verbal communication`
        assert "verbal communication" in soft
        # `effective written communication` → canonical `written communication`
        assert "written communication" in soft
        # `ability to work in a team` → canonical `teamwork`
        assert "teamwork" in soft
        # `ability to work autonomously` → canonical `working autonomously`
        assert "working autonomously" in soft

    def test_sidecar_records_moves(self, processed):
        """Audit trail must show clinical skills were moved from technical."""
        moved = processed["lexicon_meta"]["required"]["moved"]
        moved_phrases = {m["phrase"].lower(): m for m in moved}
        for kw in ("wound management", "continence management",
                   "resident charting and documentation"):
            assert kw in moved_phrases, f"{kw!r} should appear in moved"
            entry = moved_phrases[kw]
            assert entry["from"] == "technical"
            assert entry["to"] == "domain_knowledge"

    def test_lexicon_meta_exposed(self, processed):
        meta = processed["lexicon_meta"]
        assert meta["role_family"] == "nursing"
        assert meta["vertical"] == "nursing"
        assert "required" in meta and "preferred" in meta


# ---------------------------------------------------------------------------
# Idempotence + master/general fallback
# ---------------------------------------------------------------------------


class TestStructural:

    def test_idempotent(self):
        """Re-running post_process on its own output must be a no-op."""
        once = post_process_jd_analysis(HARDI_JD_RAW, role_family_id="nursing")
        twice = post_process_jd_analysis(once, role_family_id="nursing")
        # The lexicon_meta itself changes (re-processed against the cleaned
        # skills, so the dropped/moved lists are now empty) — but the SKILLS
        # themselves must be unchanged.
        for bucket in ("required_skills", "preferred_skills"):
            for cat in ("technical", "soft_skills", "domain_knowledge"):
                assert sorted(once[bucket][cat]) == sorted(twice[bucket][cat])

    def test_master_family_still_strips_noise(self):
        """Master / general family has no vertical lexicon. We must still
        strip universal noise (sector-agnostic)."""
        raw = {
            "required_skills": {
                "technical": ["python", "police check"],
                "soft_skills": [],
                "domain_knowledge": [],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        out = post_process_jd_analysis(raw, role_family_id="master")
        tech = [s.lower() for s in out["required_skills"]["technical"]]
        assert "python" in tech  # kept (no vertical lex, but not noise)
        assert "police check" not in tech  # dropped as credential
        assert "police check" in [
            s.lower() for s in out["lexicon_meta"]["required"]["credential"]
        ]

    def test_unknown_phrase_kept_in_llm_bucket(self):
        """A phrase the lexicon doesn't know stays in the LLM-assigned
        bucket (safe fallback) and is recorded in sidecar.unknown."""
        raw = {
            "required_skills": {
                "technical": ["some-future-framework-nobody-has-heard-of"],
                "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        out = post_process_jd_analysis(raw, role_family_id="tech")
        assert "some-future-framework-nobody-has-heard-of" in out["required_skills"]["technical"]
        unknowns = [u["phrase"] for u in out["lexicon_meta"]["required"]["unknown"]]
        assert "some-future-framework-nobody-has-heard-of" in unknowns


# ---------------------------------------------------------------------------
# CV-side noise filter
# ---------------------------------------------------------------------------


class TestCvSideNoiseFilter:

    def test_universal_noise_stripped_from_cv_buckets(self):
        """The CV categoriser may bucket eligibility/credentials as
        skills. The post-process must strip them."""
        cv = {
            "technical": ["bestmed", "medmobile", "police check"],
            "soft_skills": ["empathy", "australian work rights"],
            "domain_knowledge": ["dementia care", "personal safety and risk management"],
        }
        cleaned, sidecar = post_process_cv_skills(cv)
        # noise + creds + eligibility gone from skills
        assert "police check" not in [s.lower() for s in cleaned["technical"]]
        assert "australian work rights" not in [s.lower() for s in cleaned["soft_skills"]]
        assert "personal safety and risk management" not in [
            s.lower() for s in cleaned["domain_knowledge"]
        ]
        # real skills survive
        assert "bestmed" in [s.lower() for s in cleaned["technical"]]
        assert "medmobile" in [s.lower() for s in cleaned["technical"]]
        assert "empathy" in [s.lower() for s in cleaned["soft_skills"]]
        assert "dementia care" in [s.lower() for s in cleaned["domain_knowledge"]]
        # sidecar tracks what was dropped (keys are SINGULAR — match NoiseT)
        assert "police check" in [s.lower() for s in sidecar["credential"]]
        assert "australian work rights" in [s.lower() for s in sidecar["eligibility"]]
        assert "personal safety and risk management" in [
            s.lower() for s in sidecar["noise"]
        ]

    def test_clean_cv_passes_through_unchanged(self):
        """A CV with already-clean buckets must round-trip identically."""
        cv = {
            "technical": ["bestmed", "medmobile"],
            "soft_skills": ["empathy", "teamwork"],
            "domain_knowledge": ["dementia care", "personal care", "manual handling"],
        }
        cleaned, sidecar = post_process_cv_skills(cv)
        assert cleaned == cv
        assert sidecar["credential"] == []
        assert sidecar["eligibility"] == []
        assert sidecar["noise"] == []


# ---------------------------------------------------------------------------
# Tech vertical sanity (Phase 2 isn't tech-only, but must not regress it)
# ---------------------------------------------------------------------------


class TestTechVertical:

    def test_tech_jd_moves_and_canonicalises(self):
        raw = {
            "required_skills": {
                "technical": ["python", "ReactJS", "postgres", "aws"],
                "soft_skills": ["agile"],   # mis-bucketed as soft by LLM
                "domain_knowledge": ["machine learning"],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        out = post_process_jd_analysis(raw, role_family_id="tech")
        tech = [s for s in out["required_skills"]["technical"]]
        dom = [s for s in out["required_skills"]["domain_knowledge"]]
        # canonicalised
        assert "Python" in tech
        assert "React" in tech
        assert "PostgreSQL" in tech
        assert "AWS" in tech
        # `agile` moved from soft to domain
        assert "agile" in dom
        assert "agile" not in out["required_skills"]["soft_skills"]
        # ML stays in domain
        assert "machine learning" in dom
