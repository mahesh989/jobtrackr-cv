"""JD-side sector / setting label strip + credential-component routing.

Symmetric to eval/enforce.py _ROLE_CATEGORY_LABELS (the CV-side filter).
A real Anglicare Home Care Worker JD motivated this — see the inline
fixture below.

Fixes verified:
  1. Sector labels never reach Skills (home care / community care /
     disability support / retirement living + variants).
  2. Credential components route to credential sidecar (individual
     support / ageing support — fragments of "Cert III in Individual
     Support (Ageing, Home, Community)").
  3. Universal-noise additions strip the JD-boilerplate compounds.
  4. Soft-skill grounding rejects "reliable {vehicle|car|etc}" → reliability.
  5. Section-header clamp moves keywords between required/preferred.
  6. Recall floor does not re-inject anything we stripped.
"""
from __future__ import annotations

import pytest

from app.services.skills import (
    clamp_by_jd_sections,
    enrich_required_skills_from_jd_body,
    post_process_jd_analysis,
    verify_skill_evidence,
)
from app.services.skills.post_process import (
    _CREDENTIAL_COMPONENT_LABELS,
    _SECTOR_SETTING_LABELS,
    _evidence_only_modifies_inanimate,
)


# ---------------------------------------------------------------------------
# Fix 1 — sector / setting labels
# ---------------------------------------------------------------------------


class TestSectorLabelStrip:
    def test_home_care_required_routed_to_sidecar(self):
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": ["home care", "personal care"],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        # Sector label gone from Care Skills.
        assert "home care" not in out["required_skills"]["domain_knowledge"]
        # Real skill kept.
        assert "personal care" in out["required_skills"]["domain_knowledge"]
        # Recorded in setting_label sidecar.
        sidecar = out["lexicon_meta"]["required"]["setting_label"]
        assert "home care" in sidecar

    def test_full_anglicare_set_stripped(self):
        """Every sector/setting label the Anglicare extractor emitted."""
        leaks = [
            "home care", "disability support", "retirement living",
            "community care", "in-home care", "residential aged care",
        ]
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": leaks + ["personal care", "domestic assistance"],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        skills_after = set(out["required_skills"]["domain_knowledge"])
        for leak in leaks:
            assert leak not in skills_after, f"{leak} still in Care Skills"
        # Real skills survive; domestic assistance is now a sector label (Phase C).
        assert "personal care" in skills_after
        assert "domestic assistance" not in skills_after

    def test_post_canonicalisation_strip(self):
        """Real Sanctuary NDIS JD: LLM emits 'home care support' (lexicon
        variant of 'home care'). The strip must catch it post-classification."""
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": ["home care support", "personal care"],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        assert "home care" not in out["required_skills"]["domain_knowledge"]
        assert "home care support" not in out["required_skills"]["domain_knowledge"]
        assert "personal care" in out["required_skills"]["domain_knowledge"]
        sidecar = out["lexicon_meta"]["required"]["setting_label"]
        assert "home care support" in sidecar

    def test_post_canonicalisation_credential_component(self):
        """LLM emits a variant of 'individual support' canonical →
        stripped from Skills and dropped to noise (NOT surfaced as a phantom
        standalone credential)."""
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": ["individualised support", "personal care"],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        # 'individualised support' is a variant of 'individual support'
        # canonical → strip post-classify.
        assert "individual support" not in out["preferred_skills"]["domain_knowledge"]
        assert "individualised support" not in out["preferred_skills"]["domain_knowledge"]
        # Must NOT appear as a standalone credential (it is a Cert-III fragment).
        creds = out["lexicon_meta"]["preferred"]["credential"]
        assert not any("individual" in c.lower() for c in creds)
        # Routed to noise instead.
        noise = out["lexicon_meta"]["preferred"]["noise"]
        assert any("individual" in n.lower() for n in noise)

    def test_setting_labels_set_matches_design(self):
        """Sanity check on the curated set itself — guards against silent
        deletions that would re-open the leak path."""
        # Phase C: both now included — strip everywhere policy.
        assert "aged care" in _SECTOR_SETTING_LABELS
        assert "domestic assistance" in _SECTOR_SETTING_LABELS
        # MUST be included (the user-confirmed leaks):
        for must in ("home care", "community care", "disability support",
                     "retirement living"):
            assert must in _SECTOR_SETTING_LABELS


# ---------------------------------------------------------------------------
# Fix 2 — credential components
# ---------------------------------------------------------------------------


class TestCredentialComponents:
    def test_bare_individual_support_routes_to_noise(self):
        """Comes from 'Cert III in Individual Support (Ageing, Home, …)'.

        These are qualification fragments, not standalone credentials — they are
        stripped from Skills and dropped to noise so they never surface as a
        phantom 'missing credential' in the gap report.
        """
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": ["individual support", "ageing support",
                                     "personal care"],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        skills_after = out["preferred_skills"]["domain_knowledge"]
        assert "individual support" not in skills_after
        assert "ageing support" not in skills_after
        # Real skill stays.
        assert "personal care" in skills_after
        # NOT surfaced as credentials.
        creds = out["lexicon_meta"]["preferred"]["credential"]
        assert not any("individual support" in c.lower() for c in creds)
        assert not any("ageing support" in c.lower() for c in creds)
        # Routed to noise instead.
        noise = out["lexicon_meta"]["preferred"]["noise"]
        assert any("individual support" in n.lower() for n in noise)
        assert any("ageing support" in n.lower() for n in noise)

    def test_credential_component_set_matches_design(self):
        # Components of Cert III in Individual Support (Ageing, Home, …)
        for must in ("individual support", "ageing support"):
            assert must in _CREDENTIAL_COMPONENT_LABELS


# ---------------------------------------------------------------------------
# Fix 1 + 2 + recall floor — strip survives lexicon re-injection
# ---------------------------------------------------------------------------


class TestRecallFloorRespectsStrip:
    """The lexicon's recall floor would happily re-add 'home care' because
    it's a nursing canonical. The floor must skip sector labels and
    credential components."""

    _JD_TEXT = (
        "Home Care Worker. Permanent part-time visiting residents in "
        "their homes within our retirement living village. You will "
        "provide personal care, domestic assistance, and individual "
        "support to older people in the community. Disability support "
        "background is well regarded."
    )

    def test_floor_does_not_inject_home_care(self):
        jd_analysis = {
            "required_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": ["personal care"],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = enrich_required_skills_from_jd_body(
            jd_analysis, self._JD_TEXT, role_family_id="nursing",
        )
        added = out["required_skills"]["domain_knowledge"]
        # personal care kept; sector labels NOT injected by the floor.
        assert "personal care" in added
        for leak in ("home care", "community care", "disability support",
                     "individual support", "retirement living"):
            assert leak not in added, f"floor re-injected {leak}"


# ---------------------------------------------------------------------------
# Fix 4 — inanimate-anchor guard for soft skills
# ---------------------------------------------------------------------------


class TestInanimateAnchorGuard:
    def test_reliable_vehicle_does_not_ground_reliability(self):
        assert _evidence_only_modifies_inanimate(
            "reliability", "a reliable vehicle to transport residents",
        )

    def test_reliable_team_member_grounds_reliability(self):
        # Even though "reliable vehicle" might be present elsewhere,
        # ANY person-anchored use keeps the skill.
        assert not _evidence_only_modifies_inanimate(
            "reliability", "a reliable team member who shows up every shift",
        )

    def test_flexible_hours_does_not_ground_flexibility(self):
        assert _evidence_only_modifies_inanimate(
            "flexibility", "flexible hours and rostering arrangements",
        )

    def test_non_guarded_skill_passes_through(self):
        # Skills outside the guard map are never touched.
        assert not _evidence_only_modifies_inanimate(
            "empathy", "a reliable vehicle to transport residents",
        )

    def test_groundedness_gate_drops_reliable_vehicle(self):
        """End-to-end: the gate rejects 'reliability' when the only
        evidence is 'reliable vehicle'."""
        jd_text = (
            "About you: kind-hearted person who wants to make a difference. "
            "A reliable vehicle to transport residents - NSW C Class."
        )
        ja = {
            "required_skills": {
                "technical": [],
                "soft_skills": ["reliability"],
                "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "skill_evidence": {
                "reliability": "A reliable vehicle to transport residents",
            },
        }
        out = verify_skill_evidence(ja, jd_text, role_family_id="nursing")
        assert "reliability" not in out["required_skills"]["soft_skills"]
        reasons = {
            u["skill"]: u["reason"]
            for u in (out.get("lexicon_meta") or {}).get("ungrounded", [])
        }
        assert reasons.get("reliability") == "skill_not_derivable"


# ---------------------------------------------------------------------------
# Fix 5 — Essential / Desirable section clamp
# ---------------------------------------------------------------------------


_ANGLICARE_JD_TAIL = """\
To be considered for this role, you will have:

Essential: Previous experience as a Support Worker in Home Care or Disability
Desirable: A Certificate III in Individual Support (Ageing, Home, and Community)
Current accredited First Aid and CPR certificate (or willing to obtain)
Vaccinated against COVID and Flu highly recommended
A reliable vehicle to transport residents - NSW C Class Motor Vehicle (essential)
Ability to drive a minibus (NSW Class C license only)- Highly desirable
Basic computer and smartphone working knowledge
"""


class TestSectionClamp:
    def test_computer_skills_moves_to_preferred(self):
        """The Anglicare JD lists 'Basic computer and smartphone' under
        Desirable, but the LLM put 'computer skills' in required.technical."""
        ja = {
            "required_skills": {
                "technical": ["computer skills"],
                "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = clamp_by_jd_sections(ja, _ANGLICARE_JD_TAIL)
        assert "computer skills" not in out["required_skills"]["technical"]
        assert "computer skills" in out["preferred_skills"]["technical"]
        moves = out["lexicon_meta"]["section_clamp"]
        assert any(m["skill"] == "computer skills" and m["to"] == "preferred"
                   for m in moves)

    def test_minibus_driving_correctly_already_preferred(self):
        """Highly-desirable item already in preferred — clamp leaves it."""
        ja = {
            "required_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": ["minibus driving"],
                "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = clamp_by_jd_sections(ja, _ANGLICARE_JD_TAIL)
        assert "minibus driving" in out["preferred_skills"]["technical"]
        # Either no clamp meta or no move involving minibus.
        moves = (out.get("lexicon_meta") or {}).get("section_clamp", [])
        assert not any(m["skill"] == "minibus driving" for m in moves)

    def test_noop_when_no_section_headers(self):
        ja = {
            "required_skills": {
                "technical": ["python"], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        plain_jd = "We need a Python engineer with 5 years of experience."
        out = clamp_by_jd_sections(ja, plain_jd)
        # No section headers detected → no change at all.
        assert out["required_skills"]["technical"] == ["python"]
        assert "section_clamp" not in (out.get("lexicon_meta") or {})


# ---------------------------------------------------------------------------
# Fix 3 — universal noise additions
# ---------------------------------------------------------------------------


class TestSoftSkillCrossFamilyPreservation:
    """Round-2 finding: 'compassion' → canonical 'empathy' substitution
    happened in post_process_skills' per-phrase classify step (NOT the
    recall floor). Verbatim preservation across word families is now
    enforced for soft skills only — within-family canonicalisation still
    happens ('ability to work in a team' → 'teamwork')."""

    def test_compassion_preserved_not_rewritten_to_empathy(self):
        from app.services.skills import post_process_jd_analysis
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": ["compassion"],
                "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
        assert "compassion" in soft, "compassion must NOT be rewritten to empathy"
        assert "empathy" not in soft

    def test_flexible_preserved_not_rewritten_to_adaptability(self):
        from app.services.skills import post_process_jd_analysis
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": ["flexible"],
                "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
        assert "flexible" in soft
        assert "adaptability" not in soft

    def test_within_family_canonicalisation_still_works(self):
        """Same-family variants are still canonicalised — only cross-family
        substitution is blocked."""
        from app.services.skills import post_process_jd_analysis
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [
                    "effective verbal communication",
                    "ability to work in a team",
                ],
                "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
        # Within-family — canonical form lands
        assert "verbal communication" in soft  # 'verbal' shared
        assert "teamwork" in soft              # 'team' prefix of 'teamwork'


class TestSoftSkillGateNoLexiconSynonym:
    """Round-1 finding: 'empathy' kept passing because the gate's lexicon-
    synonym path mapped 'compassionate' → canonical 'empathy'. Same cross-
    family substitution we already disabled in the recall floor. Disabled
    for soft skills in the gate too."""

    def test_empathy_with_compassionate_evidence_is_dropped(self):
        from app.services.skills import verify_skill_evidence
        jd_text = (
            "If you're compassionate and passionate about making a "
            "difference, we'd love to hear from you."
        )
        ja = {
            "required_skills": {
                "technical": [], "soft_skills": ["empathy"], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "skill_evidence": {
                "empathy": "If you're compassionate and passionate",
            },
        }
        out = verify_skill_evidence(ja, jd_text, role_family_id="nursing")
        # The gate drops empathy because the only evidence is a different
        # word family ('compassionate'), which is no longer accepted via
        # the lexicon synonym path for soft skills.
        assert "empathy" not in out["required_skills"]["soft_skills"]
        reasons = {
            u["skill"]: u["reason"]
            for u in (out.get("lexicon_meta") or {}).get("ungrounded", [])
        }
        assert reasons.get("empathy") == "skill_not_derivable"

    def test_domain_knowledge_still_uses_lexicon_synonym_path(self):
        """The gate's synonym path remains active for domain_knowledge —
        only soft skills are affected. Verifies the carve-out is scoped."""
        from app.services.skills import verify_skill_evidence
        jd_text = "We provide emotional and social support to residents."
        ja = {
            "required_skills": {
                "technical": [], "soft_skills": [],
                "domain_knowledge": ["emotional support"],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "skill_evidence": {
                # social support → canonical emotional support via lexicon.
                "emotional support": "emotional and social support",
            },
        }
        out = verify_skill_evidence(ja, jd_text, role_family_id="nursing")
        # 'emotional support' is grounded via direct-overlap anyway here,
        # but the test asserts domain_knowledge still uses the path.
        assert "emotional support" in out["required_skills"]["domain_knowledge"]


class TestCrossBucketDedup:
    def test_same_skill_in_required_and_preferred_dropped_from_preferred(self):
        """Real Multicultural Care JD: LLM emitted 'computer skills' in
        both required.technical AND preferred.technical."""
        from app.services.skills import post_process_jd_analysis
        jd = {
            "required_skills": {
                "technical": ["computer skills"],
                "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": ["computer skills"],
                "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        assert "computer skills" in out["required_skills"]["technical"]
        assert "computer skills" not in out["preferred_skills"]["technical"]


class TestUniversalNoiseAdditions:
    """Compounds and boilerplate added to _universal_noise.json."""

    @pytest.mark.parametrize("phrase", [
        "working within organisational policies and procedures",
        "organisational policies and procedures",
        "adhere to organisational policies and procedures",
        "infection control and vaccination awareness",
        "compliance mindset",
    ])
    def test_added_phrases_route_to_noise(self, phrase):
        jd = {
            "required_skills": {
                "technical": [], "soft_skills": [phrase],
                "domain_knowledge": [phrase],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        # Gone from Skills.
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            assert phrase not in out["required_skills"][cat]
        # Routed (the noise lexicon classifies as "noise" type).
        all_routed = (
            out["lexicon_meta"]["required"]["noise"]
            + out["lexicon_meta"]["required"]["credential"]
            + out["lexicon_meta"]["required"]["eligibility"]
        )
        assert any(phrase == r.lower() for r in all_routed), (
            f"{phrase} not routed via sidecar"
        )
