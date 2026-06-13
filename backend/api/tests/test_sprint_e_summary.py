"""Phase 2 — Sprint E: Professional Summary S2 concreteness enforcer.

Source bug: GPT-5.1 Anglicare runs (post-Sprints A–D) keep emitting
generic / awkward S2 sentences:

  "Provides safe, respectful support for older people in facility environments."
  "Delivered safe medication assistance and comprehensive personal care to
   elderly residents using electronic systems and behavioural management
   techniques and during placement across these settings."

Both score the same on ATS as a concrete S2 ("Currently delivering care
at Jesmond Miranda Nursing Home and Uniting – The Marion using BESTMed
and MedMobile.") but waste the recruiter's 8-second skim window. Sprint
E REPLACES generic S2 with a deterministic employer-naming sentence.
"""
from __future__ import annotations

from app.services.eval.writers import (
    enforce_summary_concreteness,
    _extract_present_employers_from_experience,
    _extract_cv_named_tools_for_summary,
    _s2_has_concrete_evidence,
    _compose_concrete_s2,
)


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------


class TestEmployerExtraction:

    def test_two_present_employers_extracted(self):
        cv = """
## Experience

### Jesmond Miranda Nursing Home | Miranda, NSW

*Assistant in Nursing | May 2025 – Present*

- Bullet.

### Uniting – The Marion | Leichhardt, NSW

*Care Worker | Mar 2026 – Present*

- Bullet.

### Anglicare Mildred Symons House | Jannali, NSW

*Aged Care Placement | Sept 2024*

- Bullet.
""".lstrip()
        out = _extract_present_employers_from_experience(cv)
        assert "Jesmond Miranda Nursing Home" in out
        assert "Uniting – The Marion" in out
        # Placement (no 'Present') NOT included when Present roles exist.
        assert "Anglicare Mildred Symons House" not in out

    def test_falls_back_to_all_employers_when_no_present(self):
        cv = """
## Experience

### Some Company | NSW

*Engineer | Jan 2018 – Dec 2019*

- Bullet.

### Other Org | NSW

*Senior Engineer | Jan 2020 – Dec 2022*

- Bullet.
""".lstrip()
        out = _extract_present_employers_from_experience(cv)
        assert len(out) == 2
        assert "Some Company" in out
        assert "Other Org" in out

    def test_no_experience_section_returns_empty(self):
        assert _extract_present_employers_from_experience("## Skills\n\nPython, SQL") == []


class TestCvToolExtraction:
    def test_bestmed_medmobile_detected(self):
        cv = "Using BESTMed and MedMobile for medication administration."
        tools = _extract_cv_named_tools_for_summary(cv)
        assert "BESTMed" in tools
        assert "MedMobile" in tools

    def test_no_known_tools_returns_empty(self):
        cv = "Just a generic CV with no named tools."
        assert _extract_cv_named_tools_for_summary(cv) == []


class TestS2ConcreteEvidence:
    def test_employer_makes_concrete(self):
        assert _s2_has_concrete_evidence(
            "Delivered care at Jesmond Miranda Nursing Home.",
            ["Jesmond Miranda Nursing Home"],
            [],
        )

    def test_tool_alone_IS_concrete(self):
        """Reverted (Opal Healthcare regression 2026-06-12): tool presence
        is again treated as concrete. The previous "force rebuild on tool
        presence" behaviour gutted real AI sentences down to a 4-word stub
        and dropped the Professional Summary below the prompt's 35-word
        floor. Tool-naming is now enforced by the prompt's CANNED-SHAPE BAN
        upstream, not by the deterministic rebuilder."""
        assert _s2_has_concrete_evidence(
            "Used BESTMed daily.",
            [],
            ["BESTMed"],
        )

    def test_tool_with_employer_IS_concrete(self):
        """Employer naming still wins — a tool-named S2 with employer present
        is concrete because the employer anchor is what matters."""
        assert _s2_has_concrete_evidence(
            "Used BESTMed at Jesmond Miranda Nursing Home.",
            ["Jesmond Miranda Nursing Home"],
            ["BESTMed"],
        )

    def test_metric_makes_concrete(self):
        assert _s2_has_concrete_evidence(
            "Cared for 24 residents across 3 shifts.",
            [],
            [],
        )

    def test_pure_filler_not_concrete(self):
        assert not _s2_has_concrete_evidence(
            "Provides safe, respectful support for older people.",
            ["Jesmond Miranda Nursing Home"],
            ["BESTMed"],
        )

    def test_partial_distinctive_token_counts_as_concrete(self):
        # Hotfix: GPT-5.1 sometimes cites only the brand-suffix ("The Marion")
        # without the full "Uniting – The Marion". The distinctive token
        # 'marion' matches → counted as concrete.
        assert _s2_has_concrete_evidence(
            "...for residents living with dementia – The Marion and during placement.",
            ["Uniting – The Marion"],
            [],
        )

    def test_generic_tokens_alone_not_concrete(self):
        # "Nursing Home" appears in many org names — must NOT trigger a
        # concrete match. Only distinctive proper-noun tokens count.
        assert not _s2_has_concrete_evidence(
            "Provided care at a nursing home for older people.",
            ["Jesmond Miranda Nursing Home"],
            [],
        )

    def test_distinctive_token_jesmond_matches(self):
        # 'Jesmond' is distinctive — should count.
        assert _s2_has_concrete_evidence(
            "Delivered medication assistance at Jesmond.",
            ["Jesmond Miranda Nursing Home"],
            [],
        )


class TestComposeConcreteS2:
    """Post-canned-shape-removal: S2 anchors on EMPLOYER only — never on tools.
    Naming BESTMed/MedMobile in S2 produced a near-identical sentence across
    every nursing CV and contradicted the prompt's NO TOOL NAMES rule."""

    def test_two_employers_no_tools(self):
        s = _compose_concrete_s2(["Org A", "Org B"], [])
        assert s == "Recent experience at Org A and Org B."

    def test_one_employer_no_tools(self):
        s = _compose_concrete_s2(["Org A"], [])
        assert s == "Recent experience at Org A."

    def test_tools_are_ignored_in_output(self):
        """Tools passed in must NOT appear in the output — the prompt forbids
        naming tools in S2; the rebuilder used to violate this with
        'Currently delivering care at X using BESTMed and MedMobile'."""
        s = _compose_concrete_s2(["Org A"], ["BESTMed", "MedMobile"])
        assert "BESTMed" not in s
        assert "MedMobile" not in s
        assert "using" not in s.lower()
        assert s == "Recent experience at Org A."

    def test_two_employers_tools_ignored(self):
        s = _compose_concrete_s2(
            ["Jesmond Miranda Nursing Home", "Uniting – The Marion"],
            ["BESTMed", "MedMobile"],
        )
        assert "Jesmond Miranda Nursing Home" in s
        assert "Uniting – The Marion" in s
        assert "BESTMed" not in s
        assert "MedMobile" not in s

    def test_zero_employers_returns_empty(self):
        assert _compose_concrete_s2([], ["BESTMed"]) == ""
        assert _compose_concrete_s2([], []) == ""


# ---------------------------------------------------------------------------
# Full-pass integration
# ---------------------------------------------------------------------------


_CV_FIXTURE = """
## Experience

### Jesmond Miranda Nursing Home | Miranda, NSW

*Assistant in Nursing | May 2025 – Present*

- Manage BESTMed dosing.

### Uniting – The Marion | Leichhardt, NSW

*Care Worker | Mar 2026 – Present*

- Provide person-centred care.

Note: MedMobile is the legacy system.
""".lstrip()


class TestEnforceSummaryConcreteness:
    """The exact production bug — generic S2 gets replaced; concrete S2 stays."""

    def test_generic_s2_replaced(self):
        md = """
## Professional Summary

Care worker with experience across residential aged care settings, specialising in dementia care. Provides safe support for older people in facility environments.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        # The generic S2 should be gone.
        assert "Provides safe support" not in out
        # A concrete S2 anchored on an employer should appear (tool names are
        # intentionally excluded per the prompt's NO TOOL NAMES IN S2 rule).
        assert "Jesmond Miranda Nursing Home" in out or "Uniting" in out
        # S1 preserved unchanged.
        assert "Care worker with experience across residential aged care" in out

    def test_awkward_double_and_s2_replaced(self):
        # The exact post-Sprint-D Anglicare-run S2.
        md = """
## Professional Summary

Care worker across multiple settings. Delivered safe medication assistance and comprehensive personal care to elderly residents using electronic systems and behavioural management techniques and during placement across these settings.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        # Generic S2 with "across these settings" gone.
        assert "across these settings" not in out
        # New concrete S2 names employer.
        assert "Jesmond Miranda Nursing Home" in out

    def test_concrete_s2_with_employer_preserved(self):
        # S2 already names Jesmond → don't rewrite.
        md = """
## Professional Summary

Care worker with experience. Currently delivering care at Jesmond Miranda Nursing Home and Uniting – The Marion.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        assert out == md  # no change

    def test_strip_canned_phrase_preserves_full_s2_when_whole_sentence_is_canned(self):
        """Opal Healthcare regression (2026-06-12): when the canned phrase IS
        the entire S2, an unconditional strip leaves S2 empty and the rebuild
        fills it with a 4-word stub ("Recent experience at Uniting."). Net
        summary drops below the 35-word floor.

        Guard: the strip is skipped when it would remove ≥80% of the Summary
        section's prose. The canned phrase stays; the prompt's CANNED-SHAPE
        BAN handles future generations."""
        from app.services.eval.writers import _strip_canned_summary_phrase
        md = """
## Professional Summary

Currently delivering care at Uniting using BESTMed and MedMobile.

## Experience
""".lstrip()
        out = _strip_canned_summary_phrase(md)
        # The canned phrase should NOT be stripped (whole-sentence case).
        assert "Currently delivering" in out
        assert "Uniting" in out

    def test_strip_canned_phrase_still_strips_when_only_partial(self):
        """Sanity: the strip still works when the canned phrase is a clause
        among other content (the original intended case)."""
        from app.services.eval.writers import _strip_canned_summary_phrase
        md = """
## Professional Summary

Assistant in Nursing with three years of experience supporting elderly residents in residential aged care, specialising in dementia care and behavioural management. Currently delivering care at Uniting using BESTMed and MedMobile. Also recognised for compassion and accuracy.

## Experience
""".lstrip()
        out = _strip_canned_summary_phrase(md)
        # The canned phrase should be removed; the surrounding content stays.
        assert "Currently delivering care at Uniting using BESTMed" not in out
        assert "Assistant in Nursing with three years" in out
        assert "compassion and accuracy" in out

    def test_tool_only_s2_is_preserved(self):
        """Reverted (Opal Healthcare regression 2026-06-12): a tool-named S2
        is PRESERVED rather than force-rebuilt. The previous behaviour gutted
        the Professional Summary by replacing an informative AI sentence with
        a 4-word "Recent experience at <Emp>." stub. Tool-naming compliance
        is now handled by the prompt's CANNED-SHAPE BAN, not by deterministic
        S2 replacement."""
        md = """
## Professional Summary

Care worker with experience. Use BESTMed and MedMobile for electronic medication administration.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        # Original informative S2 is preserved — tools no longer trigger rebuild.
        assert "BESTMed" in out
        assert "MedMobile" in out

    def test_concrete_s2_with_metric_preserved(self):
        md = """
## Professional Summary

Care worker with experience. Cared for 24 residents across 3 daily shifts.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        assert out == md  # no change

    def test_anti_gut_guard_single_employer(self):
        """Opal Healthcare regression (2026-06-12): with only ONE present
        employer and no attributable tools, _compose_concrete_s2 produces a
        4-word stub ('Recent experience at Uniting.'). Replacing a fuller
        generic AI S2 with that stub drops the summary below the 35-word
        floor. The anti-gut guard keeps the AI's original S2 instead."""
        single_emp_cv = """
## Experience

### Uniting | Leichhardt, NSW

*Assistant in Nursing | Mar 2026 – Present*

- Provide person-centred care.
""".lstrip()
        # S1 is substantial; S2 is generic but fuller than a 4-word stub.
        md = """
## Professional Summary

Assistant in Nursing with experience across multiple residential aged care settings, providing person-centred care for elderly residents including those living with dementia. Supporting daily living activities and emotional wellbeing for older people in care.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, single_emp_cv)
        # The 4-word stub must NOT appear — the guard keeps the original.
        assert "Recent experience at Uniting." not in out
        # The original generic-but-fuller S2 is preserved.
        assert "Supporting daily living activities" in out

    def test_rebuild_still_fires_when_it_does_not_shorten(self):
        """Guard is narrow: when the generic S2 is itself short, the rebuild
        (which names an employer) is allowed even if total stays under floor —
        it doesn't SHORTEN, so it's not gutting."""
        single_emp_cv = """
## Experience

### Uniting | Leichhardt, NSW

*Assistant in Nursing | Mar 2026 – Present*

- Provide care.
""".lstrip()
        md = """
## Professional Summary

Care worker. Helps people.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, single_emp_cv)
        # Original S2 ("Helps people.") is 2 words; rebuild ("Recent
        # experience at Uniting.") is 4 words — does NOT shorten, so rebuild
        # is allowed.
        assert "Recent experience at Uniting" in out

    def test_idempotent(self):
        md = """
## Professional Summary

Care worker. Provides safe support for residents.

## Experience
""".lstrip()
        once = enforce_summary_concreteness(md, _CV_FIXTURE)
        twice = enforce_summary_concreteness(once, _CV_FIXTURE)
        assert once == twice

    def test_no_summary_section_noop(self):
        md = "## Experience\n\n### Org\n\n- Bullet."
        assert enforce_summary_concreteness(md, _CV_FIXTURE) == md

    def test_single_sentence_summary_noop(self):
        md = """
## Professional Summary

Just one sentence.

## Experience
""".lstrip()
        assert enforce_summary_concreteness(md, _CV_FIXTURE) == md

    def test_no_employers_in_cv_noop(self):
        md = """
## Professional Summary

Care worker. Generic S2 filler.

## Experience

Nothing parseable.
""".lstrip()
        # CV fixture below has no employers → leave alone.
        out = enforce_summary_concreteness(md, "## Skills\n\nPython")
        assert out == md
