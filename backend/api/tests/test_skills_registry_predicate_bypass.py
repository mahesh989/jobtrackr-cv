"""C27 / finding #28 — registry.py's "single authoritative is-this-junk
predicate" was bypassed by call sites that imported the weaker predicate
it wraps (skills_section._is_non_skill_phrase) directly, instead of
registry.is_non_skill_phrase.

registry.is_non_skill_phrase = (exact match in enforce._ROLE_CATEGORY_LABELS)
OR (skills_section._is_non_skill_phrase base check). 8 of
_ROLE_CATEGORY_LABELS' 14 entries — "home care", "disability support",
"disability care", "domestic assistance", "in-home care", "in home care",
"independent living support", "independent living assistance" — are NOT
covered by the base check at all, so any call site using the base check
directly is blind to them.

Two of these were LIVE bypasses (their input terms are never filtered by
_ROLE_CATEGORY_LABELS anywhere upstream, so a sector/setting descriptor
like "home care" could slip through into the delivered CV's Skills
section as if it were a genuine competency):
  - eval/writers/injection.py::_surface_matched_skills — terms come
    straight from the JD/CV matcher's own output.
  - pipeline/steps/tailored_cv/skills_injection.py::_inject_missing_skills
    — terms come straight from the feasibility plan's raw buckets.

Two others (_inject_approved_skills, force_inject_missed_approved) were
ALSO using the weaker predicate directly, but were not live bugs — both
already call _approved_skill_entries(), which does its own separate
_ROLE_CATEGORY_LABELS check upstream. Fixed anyway for the reason
registry.py's own docstring states: "All call sites that previously
reimplemented this check should route through here" — removes a fragile,
non-obvious cross-function coupling in favour of the single source of
truth, with zero behaviour change for these two (confirmed below).
"""
from __future__ import annotations

from app.services.eval.enforce import _ROLE_CATEGORY_LABELS
from app.services.eval.writers.injection import (
    _inject_approved_skills,
    _surface_matched_skills,
    force_inject_missed_approved,
)
from app.services.eval.writers.skills_section import _is_non_skill_phrase
from app.services.pipeline.steps.tailored_cv import _inject_missing_skills
from app.services.skills.registry import is_non_skill_phrase


def _feasibility(*entries: tuple[str, str, str]) -> dict:
    """Build a feasibility dict from (keyword, category, bucket_name) tuples."""
    plan: dict = {"inject_directly": [], "inject_as_extension": [], "inject_with_inference": []}
    for kw, cat, bucket_name in entries:
        plan[bucket_name].append({"keyword": kw, "category": cat, "bucket": "required"})
    return {"feasibility_plan": plan}


_SKILLS_MD = (
    "## Skills\n"
    "**Technical Skills:** Python\n"
    "**Soft Skills:** Communication\n"
    "**Other Skills:** BESTMed\n\n"
    "## Experience\n"
)


class TestGapTermsInvisibleToBasePredicate:
    """Establishes the actual gap this chunk fixes — not an assumption."""

    def test_eight_role_category_labels_only_caught_by_registry(self):
        gap_terms = {
            "home care", "disability support", "disability care",
            "domestic assistance", "in-home care", "in home care",
            "independent living support", "independent living assistance",
        }
        assert gap_terms <= _ROLE_CATEGORY_LABELS
        for term in gap_terms:
            assert not _is_non_skill_phrase(term), (
                f"{term!r} unexpectedly caught by the base predicate — "
                "this test's premise (a genuine gap) no longer holds"
            )
            assert is_non_skill_phrase(term), (
                f"{term!r} not caught by registry.is_non_skill_phrase either"
            )


class TestInjectMissingSkillsNoLongerLeaksSectorLabels:
    """pipeline/steps/tailored_cv/skills_injection.py::_inject_missing_skills
    — genuine live bypass: terms come straight from the feasibility plan's
    raw buckets, with no _ROLE_CATEGORY_LABELS filtering anywhere upstream."""

    def test_home_care_no_longer_injected(self):
        feas = _feasibility(("home care", "domain_knowledge", "inject_directly"))
        out = _inject_missing_skills(_SKILLS_MD, feas)
        assert "Home Care" not in out

    def test_disability_support_no_longer_injected(self):
        feas = _feasibility(("disability support", "domain_knowledge", "inject_directly"))
        out = _inject_missing_skills(_SKILLS_MD, feas)
        assert "Disability Support" not in out

    def test_genuine_skill_still_injected(self):
        feas = _feasibility(("medication administration", "domain_knowledge", "inject_directly"))
        out = _inject_missing_skills(_SKILLS_MD, feas)
        assert "Medication Administration" in out


class TestSurfaceMatchedSkillsNoLongerLeaksSectorLabels:
    """eval/writers/injection.py::_surface_matched_skills — genuine live
    bypass: terms come straight from the JD/CV matcher's own matched
    output, with no _ROLE_CATEGORY_LABELS filtering anywhere upstream."""

    def test_disability_support_no_longer_surfaced(self):
        matching = {"matched": {"required": {"domain_knowledge": ["disability support"]}}}
        out = _surface_matched_skills(_SKILLS_MD, matching)
        assert "Disability Support" not in out

    def test_home_care_no_longer_surfaced(self):
        matching = {"matched": {"required": {"domain_knowledge": ["home care"]}}}
        out = _surface_matched_skills(_SKILLS_MD, matching)
        assert "Home Care" not in out

    def test_genuine_skill_still_surfaced(self):
        matching = {"matched": {"required": {"domain_knowledge": ["manual handling"]}}}
        out = _surface_matched_skills(_SKILLS_MD, matching)
        assert "Manual Handling" in out


class TestInjectApprovedSkillsRoutesThroughRegistryWithNoBehaviourChange:
    """eval/writers/injection.py::_inject_approved_skills — not a live bug
    (already indirectly protected via _approved_skill_entries' own
    _ROLE_CATEGORY_LABELS check upstream), but now routes through the
    single authoritative predicate instead of duplicating the logic."""

    def test_role_category_label_still_excluded(self):
        md = (
            "## Skills\n"
            "**Care Skills:** Personal Care\n"
            "**Soft Skills:** Empathy, Teamwork, Communication, Time Management, Adaptability, Reliability\n"
            "**Other Skills:** BESTMed\n\n"
            "## Experience\n"
        )
        # _approved_skill_entries already drops exact _ROLE_CATEGORY_LABELS
        # matches before this function ever sees them, so "home care" never
        # reaches _inject_approved_skills at all — this pins that pre-existing
        # protection stays intact after the routing change.
        feas = _feasibility(("home care", "domain_knowledge", "inject_directly"))
        out = _inject_approved_skills(md, feas)
        assert "Home Care" not in out

    def test_genuine_skill_still_injected_past_cap(self):
        md = (
            "## Skills\n"
            "**Care Skills:** Personal Care, Dementia Care\n"
            "**Soft Skills:** Empathy, Teamwork, Communication, Time Management, Adaptability, Reliability\n"
            "**Other Skills:** BESTMed, MedMobile\n\n"
            "## Experience\n"
        )
        feas = _feasibility(("verbal communication", "soft_skills", "inject_directly"))
        out = _inject_approved_skills(md, feas)
        assert "Verbal Communication" in out


class TestForceInjectMissedApprovedRoutesThroughRegistryWithNoBehaviourChange:
    """eval/writers/injection.py::force_inject_missed_approved — same as
    _inject_approved_skills: not a live bug, now routes through the single
    authoritative predicate instead of duplicating the logic."""

    def test_role_category_label_still_excluded(self):
        md = (
            "## Skills\n"
            "**Care Skills:** Personal Care\n\n"
            "## Experience\n"
        )
        feas = _feasibility(("home care", "domain_knowledge", "inject_directly"))
        out, notes = force_inject_missed_approved(md, feas)
        assert "Home Care" not in out

    def test_genuine_skill_still_force_injected(self):
        md = (
            "## Skills\n"
            "**Care Skills:** Personal Care\n\n"
            "## Experience\n"
        )
        feas = _feasibility(("dementia care", "domain_knowledge", "inject_directly"))
        out, notes = force_inject_missed_approved(md, feas)
        assert "Dementia Care" in out
