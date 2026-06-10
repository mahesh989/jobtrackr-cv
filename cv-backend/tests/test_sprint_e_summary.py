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

    def test_tool_makes_concrete(self):
        assert _s2_has_concrete_evidence(
            "Used BESTMed daily.",
            [],
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

    def test_concrete_s2_with_tool_preserved(self):
        md = """
## Professional Summary

Care worker with experience. Use BESTMed and MedMobile for electronic medication administration.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        assert out == md  # no change

    def test_concrete_s2_with_metric_preserved(self):
        md = """
## Professional Summary

Care worker with experience. Cared for 24 residents across 3 daily shifts.

## Experience
""".lstrip()
        out = enforce_summary_concreteness(md, _CV_FIXTURE)
        assert out == md  # no change

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
