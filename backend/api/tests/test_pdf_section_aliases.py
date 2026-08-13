"""C22 / finding #25 — role-pack section headings with no PDF alias entry.

``nursing``'s own ``section_order`` (verticals/nursing/config.py) places
"Registration & Licences" right after "Certifications". ``manual``'s own
``section_order`` (verticals/manual/config.py) places "Certifications & Checks"
then "Availability" last. But the PDF generator's own, separate canonical
order (``pdf_generator/parsing.py::_SECTION_ALIASES`` /
``_SECTION_ORDER``) has no entry for any of these three headings, so
``_build_story`` buckets them as unknown "extras" and renders them dead
last — after every canonically-ordered section, including References —
regardless of where the vertical itself says they belong.
"""
from __future__ import annotations

import app.services.cv.pdf_generator.parsing as parsing
import app.services.cv.pdf_generator.sections as sections


def _story_header_order(monkeypatch, sections_in):
    seen: list[str] = []
    monkeypatch.setattr(sections, "_section_header", lambda title: (seen.append(title) or []))
    monkeypatch.setattr(sections, "_render_section", lambda stype, items: [])
    sections._build_story("Jane Doe", "jane@example.com", sections_in)
    return seen


class TestAliasMapCoversRolePackHeadings:
    def test_registration_and_licences_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("registration & licences") is not None

    def test_certifications_and_checks_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("certifications & checks") is not None

    def test_availability_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("availability") is not None

    def test_every_alias_target_is_a_real_canonical_bucket(self):
        for heading, key in parsing._SECTION_ALIASES.items():
            assert key in parsing._SECTION_ORDER, (
                f"{heading!r} aliases to {key!r}, which is not in _SECTION_ORDER"
            )
            assert key in parsing._SECTION_LABELS, (
                f"{key!r} has no fallback label — _build_story KeyErrors "
                "if the AI ever emits this heading with empty title text"
            )


class TestNursingRegistrationRendersInVerticalOrder:
    """nursing/config.py: "Certifications", "Registration & Licences" —
    Registration must not be pushed after sections nursing's own order
    doesn't even mention (Awards, References)."""

    def test_registration_renders_before_references(self, monkeypatch):
        order = _story_header_order(monkeypatch, [
            ("Professional Summary", [{"type": "paragraph", "text": "x"}]),
            ("Experience", [{"type": "bullet", "text": "x"}]),
            ("Certifications", [{"type": "bullet", "text": "x"}]),
            ("References", [{"type": "paragraph", "text": "x"}]),
            ("Registration & Licences", [{"type": "paragraph", "text": "x"}]),
        ])
        assert order.index("Registration & Licences") < order.index("References")

    def test_registration_renders_before_awards(self, monkeypatch):
        order = _story_header_order(monkeypatch, [
            ("Professional Summary", [{"type": "paragraph", "text": "x"}]),
            ("Certifications", [{"type": "bullet", "text": "x"}]),
            ("Awards", [{"type": "bullet", "text": "x"}]),
            ("Registration & Licences", [{"type": "paragraph", "text": "x"}]),
        ])
        assert order.index("Registration & Licences") < order.index("Awards")

    def test_registration_renders_after_certifications(self, monkeypatch):
        """Matches nursing's own section_order: Certifications, then
        Registration & Licences — not the reverse."""
        order = _story_header_order(monkeypatch, [
            ("Registration & Licences", [{"type": "paragraph", "text": "x"}]),
            ("Certifications", [{"type": "bullet", "text": "x"}]),
        ])
        assert order.index("Certifications") < order.index("Registration & Licences")


class TestManualRolePackRendersInVerticalOrder:
    """manual/config.py: "Certifications & Checks", "Availability" — both
    unaliased today, so both were pushed to the very end in source order,
    which happened to hide the bug for THIS pair alone; the real defect
    is they'd both land after References/Awards if either were present."""

    def test_certifications_and_checks_renders_before_references(self, monkeypatch):
        order = _story_header_order(monkeypatch, [
            ("Summary", [{"type": "paragraph", "text": "x"}]),
            ("References", [{"type": "paragraph", "text": "x"}]),
            ("Certifications & Checks", [{"type": "bullet", "text": "x"}]),
        ])
        assert order.index("Certifications & Checks") < order.index("References")

    def test_availability_renders_after_certifications_and_checks(self, monkeypatch):
        """manual's own order: Certifications & Checks, then Availability."""
        order = _story_header_order(monkeypatch, [
            ("Availability", [{"type": "paragraph", "text": "x"}]),
            ("Certifications & Checks", [{"type": "bullet", "text": "x"}]),
        ])
        assert order.index("Certifications & Checks") < order.index("Availability")

    def test_availability_is_not_dropped_from_the_canonical_bucketing(self, monkeypatch):
        """Before the fix, "Availability" fell into `extras` (unknown
        sections) rather than a named canonical bucket — this asserts it
        is now recognised, not just coincidentally rendered."""
        assert parsing._SECTION_ALIASES["availability"] in parsing._SECTION_ORDER
