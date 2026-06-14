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
