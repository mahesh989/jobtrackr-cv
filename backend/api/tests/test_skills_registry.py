"""Guard test for skills.registry — ensures all CATEGORIES definitions
are consistent across modules (L6 from jd-analysis-diagnosis.md).

The circular import chain prevents pipeline modules from importing
CATEGORIES directly from registry, so we enforce consistency via this test.
"""
from __future__ import annotations


def test_categories_consistent_across_modules():
    """All modules that define _CATEGORIES must agree on the same tuple."""
    from app.services.skills.registry import CATEGORIES

    # pipeline steps define their own tuple (can't import registry due to
    # circular dep) — verify they match
    import app.services.pipeline.steps.cv_jd_matching as m1
    import app.services.pipeline.steps.keyword_feasibility as m2
    import app.services.pipeline.steps.input_recommendations as m3

    assert tuple(m1._CATEGORIES) == tuple(CATEGORIES), "cv_jd_matching._CATEGORIES diverged"
    assert tuple(m2._CATEGORIES) == tuple(CATEGORIES), "keyword_feasibility._CATEGORIES diverged"
    assert tuple(m3._CATEGORIES) == tuple(CATEGORIES), "input_recommendations._CATEGORIES diverged"


def test_au_unit_prefixes_exported():
    """registry.AU_UNIT_PREFIXES must be a non-empty frozenset."""
    from app.services.skills.registry import AU_UNIT_PREFIXES
    assert isinstance(AU_UNIT_PREFIXES, frozenset)
    assert len(AU_UNIT_PREFIXES) > 10, "AU_UNIT_PREFIXES seems unexpectedly short"
    assert "chc" in AU_UNIT_PREFIXES
    assert "hlt" in AU_UNIT_PREFIXES


def test_is_non_skill_phrase_strips_sector_labels():
    """registry.is_non_skill_phrase must catch known sector labels."""
    from app.services.skills.registry import is_non_skill_phrase

    for label in ("aged care", "domestic assistance", "home care", "disability support"):
        assert is_non_skill_phrase(label), f"Expected {label!r} to be non-skill"

    # Real skills must survive
    for skill in ("personal care", "manual handling", "medication administration"):
        assert not is_non_skill_phrase(skill), f"Expected {skill!r} to be a real skill"
