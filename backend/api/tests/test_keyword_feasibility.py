"""Soft-skill inference rule tests (Loop fix 4 / Class B).

Validates that the deterministic rule table promotes obvious-inference
soft skills (empathy, compliance mindset, tolerance, etc.) out of
cannot_inject when the source CV evidences the activity.
"""
from __future__ import annotations

from app.services.pipeline.steps.keyword_feasibility import (
    _apply_soft_skill_inference_rules,
)


_SHANTI_CV = (
    "Aged Care Support Worker with Certificate IV in Ageing Support. "
    "Completed 120-hour placement at RFBI Concord Community Village. "
    "Provided personal care to elderly residents, including individuals "
    "with dementia. Followed legal and ethical standards in aged care. "
    "Supported residents through social engagement activities and mental "
    "health support. Collaborated with the multidisciplinary team."
)


def _plan_with(gaps):
    return {
        "inject_directly": [],
        "inject_as_extension": [],
        "inject_with_inference": [],
        "cannot_inject": [{"keyword": kw, "category": "soft_skills",
                            "bucket": "required"} for kw in gaps],
    }


class TestSoftSkillInferenceRules:

    def test_empathy_promoted_when_source_has_dementia_care(self):
        plan = _plan_with(["empathy"])
        out = _apply_soft_skill_inference_rules(plan, _SHANTI_CV)
        gaps = [e["keyword"] for e in out["cannot_inject"]]
        promoted = [e["keyword"] for e in out["inject_as_extension"]]
        assert "empathy" not in gaps
        assert "empathy" in promoted
        # Reason should cite the evidence phrase from the rule table
        e = next(x for x in out["inject_as_extension"] if x["keyword"] == "empathy")
        assert "dementia" in e["evidence"].lower() or "palliative" in e["evidence"].lower() \
               or "elderly" in e["evidence"].lower() or "personal care" in e["evidence"].lower()

    def test_compliance_mindset_promoted_via_legal_and_ethical(self):
        plan = _plan_with(["compliance mindset"])
        out = _apply_soft_skill_inference_rules(plan, _SHANTI_CV)
        assert "compliance mindset" not in [e["keyword"] for e in out["cannot_inject"]]
        assert "compliance mindset" in [e["keyword"] for e in out["inject_as_extension"]]

    def test_tolerance_promoted_via_dementia(self):
        plan = _plan_with(["tolerance"])
        out = _apply_soft_skill_inference_rules(plan, _SHANTI_CV)
        assert "tolerance" in [e["keyword"] for e in out["inject_as_extension"]]

    def test_sense_of_belonging_promoted_via_social_engagement(self):
        plan = _plan_with(["sense of belonging"])
        out = _apply_soft_skill_inference_rules(plan, _SHANTI_CV)
        assert "sense of belonging" in [e["keyword"] for e in out["inject_as_extension"]]

    def test_unknown_skill_stays_in_honest_gaps(self):
        plan = _plan_with(["disability support"])  # not in rules
        out = _apply_soft_skill_inference_rules(plan, _SHANTI_CV)
        assert "disability support" in [e["keyword"] for e in out["cannot_inject"]]
        assert out["inject_as_extension"] == []

    def test_skill_in_rules_but_no_evidence_stays_in_gaps(self):
        # Empty CV → no evidence phrase matches → no promotion
        plan = _plan_with(["empathy"])
        out = _apply_soft_skill_inference_rules(plan, "Just a name. No experience.")
        assert "empathy" in [e["keyword"] for e in out["cannot_inject"]]
        assert out["inject_as_extension"] == []

    def test_empty_cannot_inject_is_noop(self):
        plan = _plan_with([])
        out = _apply_soft_skill_inference_rules(plan, _SHANTI_CV)
        assert out["cannot_inject"] == []
        assert out["inject_as_extension"] == []


class TestForceInjectMissedApproved:
    """Force-inject pass — every approved keyword lands SOMEWHERE in Skills,
    even when the regular cap-aware injector silently drops it via
    label-mismatch (technical category on a nursing CV with no Technical
    Skills line)."""

    def test_computer_skills_lands_in_other_skills_on_nursing(self):
        from app.services.eval.writers.injection import force_inject_missed_approved
        # Nursing-shaped Skills section: Care/Soft/Other, NO Technical line.
        md = (
            "# Test\n## Skills\n"
            "- **Care Skills:** Personal Care, Dementia Support\n"
            "- **Soft Skills:** Empathy, Teamwork\n"
            "- **Other Skills:** Accounting\n"
        )
        feasibility = {"feasibility_plan": {
            "inject_directly": [],
            "inject_as_extension": [{"keyword": "computer skills",
                                      "category": "technical", "bucket": "required"}],
            "inject_with_inference": [],
            "cannot_inject": [],
        }}
        out, notes = force_inject_missed_approved(md, feasibility)
        # "computer skills" should land in Other Skills (technical preference
        # for nursing falls back to Other Skills line).
        assert "Computer Skills" in out
        # And specifically on the Other Skills line, not Care/Soft
        other_line = next(l for l in out.split("\n") if "Other Skills" in l)
        assert "computer skills" in other_line.lower()
        assert notes  # logged the force-inject

    def test_already_present_is_noop(self):
        from app.services.eval.writers.injection import force_inject_missed_approved
        md = (
            "## Skills\n"
            "- **Other Skills:** Computer Skills, Accounting\n"
        )
        feasibility = {"feasibility_plan": {
            "inject_directly": [],
            "inject_as_extension": [{"keyword": "computer skills",
                                      "category": "technical", "bucket": "required"}],
            "inject_with_inference": [],
            "cannot_inject": [],
        }}
        out, notes = force_inject_missed_approved(md, feasibility)
        assert out == md
        assert notes == []

    def test_non_skill_phrase_not_forced(self):
        # "experience in aged care" matches _is_non_skill_phrase → never injected
        from app.services.eval.writers.injection import force_inject_missed_approved
        md = "## Skills\n- **Care Skills:** Personal Care\n"
        feasibility = {"feasibility_plan": {
            "inject_directly": [{"keyword": "experience in aged care",
                                  "category": "domain_knowledge", "bucket": "required"}],
            "inject_as_extension": [], "inject_with_inference": [], "cannot_inject": [],
        }}
        out, notes = force_inject_missed_approved(md, feasibility)
        assert "experience in aged care" not in out.lower()
        assert notes == []


class TestInjectDirectlyGroundednessGate:
    """Real Shanti tailored runs surfaced: the LLM puts cross-skill rationale
    entries into inject_directly. e.g. evidence 'dressing, bathing, feeding'
    → claim 'continence care'. The deterministic gate downgrades any
    inject_directly entry whose evidence quote doesn't share a word-family
    token with the keyword. Same data survives — moves to
    inject_with_inference so the UI labels it 'Inferred from adjacent
    evidence' instead of 'Strong CV evidence'."""

    _CV = (
        "Aged Care Placement at RFBI Concord. Assisted with daily living "
        "activities including dressing, bathing, feeding, and mobility "
        "support. Time Management & Prioritization. Infection Control "
        "& Workplace Safety. Continence care for residents."
    )

    def test_cross_skill_inference_downgraded(self):
        from app.services.pipeline.steps.keyword_feasibility import (
            _enforce_inject_directly_groundedness,
        )
        plan = {
            "inject_directly": [
                # The LLM-emitted cross-skill claim — evidence is in CV
                # but doesn't share word family with the keyword.
                {"keyword": "risk management",
                 "category": "domain_knowledge", "bucket": "required",
                 "evidence": "Infection Control & Workplace Safety",
                 "rationale": "infection control is risk management"},
            ],
            "inject_as_extension": [],
            "inject_with_inference": [],
            "cannot_inject": [],
        }
        out = _enforce_inject_directly_groundedness(plan, self._CV)
        # Gone from direct
        assert out["inject_directly"] == []
        # In inference, with the rationale preserved
        infs = out["inject_with_inference"]
        assert len(infs) == 1
        assert infs[0]["keyword"] == "risk management"
        assert "infection control" in infs[0]["inference_chain"].lower()
        assert infs[0]["inferred_from"] == ["Infection Control & Workplace Safety"]
        assert infs[0]["confidence"] == "medium"

    def test_verbatim_keyword_kept_in_direct(self):
        """When the evidence quote contains the keyword's word family,
        keep inject_directly — this is the legitimate case."""
        from app.services.pipeline.steps.keyword_feasibility import (
            _enforce_inject_directly_groundedness,
        )
        plan = {
            "inject_directly": [
                {"keyword": "continence care",
                 "category": "domain_knowledge", "bucket": "required",
                 "evidence": "Continence care for residents",
                 "rationale": "literal"},
            ],
            "inject_as_extension": [],
            "inject_with_inference": [],
            "cannot_inject": [],
        }
        out = _enforce_inject_directly_groundedness(plan, self._CV)
        assert len(out["inject_directly"]) == 1
        assert out["inject_with_inference"] == []

    def test_evidence_not_in_cv_downgraded(self):
        """Even if the LLM cites text that looks plausible, if it's not in
        the actual CV the entry must be downgraded."""
        from app.services.pipeline.steps.keyword_feasibility import (
            _enforce_inject_directly_groundedness,
        )
        plan = {
            "inject_directly": [
                {"keyword": "wound care",
                 "category": "domain_knowledge", "bucket": "required",
                 "evidence": "Performed wound care daily",  # NOT in CV
                 "rationale": ""},
            ],
            "inject_as_extension": [],
            "inject_with_inference": [],
            "cannot_inject": [],
        }
        out = _enforce_inject_directly_groundedness(plan, self._CV)
        assert out["inject_directly"] == []
        assert len(out["inject_with_inference"]) == 1

    def test_empty_evidence_downgraded(self):
        from app.services.pipeline.steps.keyword_feasibility import (
            _enforce_inject_directly_groundedness,
        )
        plan = {
            "inject_directly": [
                {"keyword": "teamwork",
                 "category": "soft_skills", "bucket": "required",
                 "evidence": "", "rationale": "implied"},
            ],
            "inject_as_extension": [],
            "inject_with_inference": [],
            "cannot_inject": [],
        }
        out = _enforce_inject_directly_groundedness(plan, self._CV)
        assert out["inject_directly"] == []

    def test_within_family_inflection_accepted(self):
        """managing/management/manager all share the 'manag' prefix —
        within-family rewrite acceptable in inject_directly."""
        from app.services.pipeline.steps.keyword_feasibility import (
            _enforce_inject_directly_groundedness,
        )
        cv = "Managed the rostering process; managing 12 carers daily."
        plan = {
            "inject_directly": [
                {"keyword": "management",
                 "category": "soft_skills", "bucket": "required",
                 "evidence": "Managed the rostering process",
                 "rationale": ""},
            ],
            "inject_as_extension": [],
            "inject_with_inference": [],
            "cannot_inject": [],
        }
        out = _enforce_inject_directly_groundedness(plan, cv)
        # 'managed' is a within-family token of 'management' → kept direct.
        assert len(out["inject_directly"]) == 1

    def test_empty_plan_no_op(self):
        from app.services.pipeline.steps.keyword_feasibility import (
            _enforce_inject_directly_groundedness,
        )
        plan = {"inject_directly": [], "inject_as_extension": [],
                "inject_with_inference": [], "cannot_inject": []}
        out = _enforce_inject_directly_groundedness(plan, self._CV)
        assert out == plan
