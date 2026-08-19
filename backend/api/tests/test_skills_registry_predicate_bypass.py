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

Round 2 (independent review): a 5th bypass, skills_section.py's own
_strip_non_skill_phrases, was found — and this one is a LIVE bug on
EVERY vertical, unlike the two round-1 live bugs (which get partially
masked for the nursing vertical by a later lexicon-reroute pass). It is
the module's OWN designated last-resort safety net — writers/_impl.py's
"3a-bis" call site explicitly documents it as stripping non-skill
entries "no matter whether the base classifier or the surfacing pass
added them" — so an AI writer emitting a bare sector label directly
into the Skills section (no injector involved at all; historically the
most common source of this leak class) sailed straight through it.
"""
from __future__ import annotations

from app.services.eval.enforce import _ROLE_CATEGORY_LABELS, _split_compound_skills
from app.services.eval.writers.injection import (
    _inject_approved_skills,
    _surface_matched_skills,
    force_inject_missed_approved,
)
from app.services.eval.writers.skills_section import (
    _is_non_skill_phrase,
    _strip_non_skill_phrases,
)
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


class TestStripNonSkillPhrasesNoLongerLeaksSectorLabels:
    """eval/writers/skills_section.py::_strip_non_skill_phrases — round-2
    finding (independent review). This is the safety-net pass writers/
    _impl.py's "3a-bis" call site documents as stripping non-skill entries
    "no matter whether the base classifier or the surfacing pass added
    them" — i.e. it exists specifically to catch every OTHER leak class,
    including a sector label the AI writer itself put directly into the
    Skills section (no injector involved). It was still routed through the
    weaker base predicate, so it was blind to the same 8 terms — and
    unlike the two round-1 live bugs, nothing downstream masks this one on
    any vertical."""

    def test_sector_labels_stripped_from_writer_authored_skills_line(self):
        md = (
            "## Skills\n"
            "**Care Skills:** Personal Care, Home Care, Disability Support, "
            "Domestic Assistance, In-Home Care\n\n"
            "## Experience\n"
        )
        out = _strip_non_skill_phrases(md)
        for term in ("Home Care", "Disability Support", "Domestic Assistance", "In-Home Care"):
            assert term not in out
        assert "Personal Care" in out

    def test_experience_narrative_is_not_touched(self):
        """Scoping guard: the function only ever operates on lines within
        the ## Skills section boundaries — the same sector words appearing
        in ordinary Experience prose must survive verbatim."""
        md = (
            "## Experience\n"
            "### Org A | Sydney\n"
            "- Provided home care and disability support to elderly residents.\n\n"
            "## Skills\n"
            "**Care Skills:** Personal Care, Home Care\n\n"
            "## Awards\n"
        )
        out = _strip_non_skill_phrases(md)
        assert "Provided home care and disability support to elderly residents." in out
        skills_block = out.split("## Skills")[1].split("## Awards")[0]
        assert "Home Care" not in skills_block
        assert "Personal Care" in skills_block


class TestSplitCompoundSkillsMustRunBeforeStripNonSkillPhrases:
    """C27b — from C27's round-2 review: `_split_compound_skills`
    (enforce.py, called at the top of `enforce_skills_section`) runs BEFORE
    `_strip_non_skill_phrases` (skills_section.py) at every real call site
    in writers/_impl.py (the first `enforce_skills_section(...)` call at
    line ~457 happens before the `_strip_non_skill_phrases(md)` call at
    line ~482). The reviewer found this order is load-bearing, not
    incidental: `_strip_non_skill_phrases` matches each physical line
    against `_SKILLS_LINE_RE`, which expects exactly ONE bold category
    marker per line — an AI-authored line merging two categories onto one
    physical line ("**Other Skills:** Cooking **Care Skills:** Home Care,
    Meal Prep") fails that regex entirely, so the whole line — gap term
    included — passes through `_strip_non_skill_phrases` completely
    unfiltered. `_split_compound_skills` normalises exactly this shape
    into separate single-marker lines FIRST, which is what lets
    `_strip_non_skill_phrases` see "Home Care" as an isolated item on its
    own "**Care Skills:**" line and strip it.

    This test exists because the invariant had no regression coverage —
    a future refactor swapping the call order in writers/_impl.py would
    silently reopen finding #28's exact leak class for any AI output that
    happens to merge two categories onto one line, and nothing would fail
    until it was found live again.
    """

    _MERGED_MARKER_MD = (
        "## Skills\n"
        "**Other Skills:** Cooking **Care Skills:** Home Care, Meal Preparation\n\n"
        "## Experience\n"
    )

    def test_split_then_strip_removes_the_gap_term(self):
        """The real production order (split first, strip second) correctly
        isolates and removes the sector-label gap term."""
        split_first = _split_compound_skills(self._MERGED_MARKER_MD)
        out = _strip_non_skill_phrases(split_first)
        assert "Home Care" not in out
        assert "Cooking" in out
        assert "Meal Preparation" in out

    def test_strip_then_split_lets_the_gap_term_survive(self):
        """REGRESSION GUARD, proven by construction: the reverse order (the
        exact mistake a future refactor could make) fails to catch the gap
        term, because _strip_non_skill_phrases never recognises the merged
        line as a skills line in the first place. This test's job is to
        fail loudly if a future change makes both orders behave the same —
        that would mean this invariant stopped being load-bearing and the
        comment/test above is stale, not that the bug is fixed."""
        strip_first = _strip_non_skill_phrases(self._MERGED_MARKER_MD)
        out = _split_compound_skills(strip_first)
        assert "Home Care" in out
