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

import io

import pypdf

import app.services.cv.pdf_generator.parsing as parsing
import app.services.cv.pdf_generator.sections as sections
from app.services.cv.pdf_generator import generate_pdf_from_markdown


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

    def test_clinical_experience_has_an_alias(self):
        # C22d: nursing's own section_order used this exact phrase until
        # commit e4a20824 (2026-05-30) renamed it to plain "Experience" —
        # enforce_w8.py/verify.py/bridges.py/awards.py all still recognise
        # it as an experience-heading synonym, but this alias map didn't.
        assert parsing._SECTION_ALIASES.get("clinical experience") == "experience"

    def test_registration_with_the_word_and_instead_of_ampersand_has_an_alias(self):
        # C22c: a plausible LLM "&" -> "and" typography normalisation of
        # the prompt's literal "Registration & Licences" section_order
        # heading — single-module evidence (awards.py's own defensive
        # list) but well-grounded in generic drift risk.
        assert parsing._SECTION_ALIASES.get("registration and licences") == "registration"

    def test_registration_bare_has_an_alias(self):
        # C22c: doubly corroborated — awards.py's own defensive list AND
        # tailored_structural_validation/gates_prose.py's independently-
        # written ghost-reference gate both defend against this.
        assert parsing._SECTION_ALIASES.get("registration") == "registration"

    def test_registrations_plural_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("registrations") == "registration"

    def test_licences_bare_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("licences") == "registration"

    def test_licenses_bare_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("licenses") == "registration"

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


class TestClinicalExperienceRendersInCanonicalOrder:
    """C22d: "Clinical Experience" was nursing's own section_order heading
    until commit e4a20824 (2026-05-30) renamed it to plain "Experience".
    enforce_w8.py/verify.py/bridges.py/awards.py never stopped recognising
    the old phrase as an experience-heading synonym, but the PDF alias map
    did — a composition-prompt slip back to this domain-idiomatic phrase
    (real production precedent, not an arbitrary invention) would render
    dead last in extras instead of in the experience slot."""

    def test_clinical_experience_renders_before_references(self, monkeypatch):
        order = _story_header_order(monkeypatch, [
            ("Professional Summary", [{"type": "paragraph", "text": "x"}]),
            ("Clinical Experience", [{"type": "bullet", "text": "Did clinical things"}]),
            ("References", [{"type": "paragraph", "text": "x"}]),
        ])
        assert order.index("Clinical Experience") < order.index("References")

    def test_clinical_experience_is_bucketed_as_experience_not_extras(self):
        assert parsing._SECTION_ALIASES["clinical experience"] == "experience"


class TestChecksAndClearancesRendersInVerticalOrder:
    """Round-2 independent review finding: eval/enforce_w8.py's
    _relabel_registration relabels "## Registration & Licences" to
    "## Checks & Clearances" whenever the CV holds only clearances (police
    check, NDIS, WWCC, first aid…) with no genuine AHPRA/RN/EN registration
    — the common case for aged/personal/disability care workers, which
    nursing's own alias list (verticals/nursing/config.py) explicitly
    targets. This relabelled heading had no alias at all, so it still fell
    into extras and rendered dead last — the original bug, unfixed for
    what is likely the majority of this repo's nursing users."""

    def test_checks_and_clearances_has_an_alias(self):
        assert parsing._SECTION_ALIASES.get("checks & clearances") is not None

    def test_checks_and_clearances_renders_before_references(self, monkeypatch):
        order = _story_header_order(monkeypatch, [
            ("Professional Summary", [{"type": "paragraph", "text": "x"}]),
            ("Certifications", [{"type": "bullet", "text": "x"}]),
            ("References", [{"type": "paragraph", "text": "x"}]),
            ("Checks & Clearances", [{"type": "paragraph", "text": "x"}]),
        ])
        assert order.index("Checks & Clearances") < order.index("References")

    def test_checks_and_clearances_renders_before_references_end_to_end(self):
        """Same claim, verified against real rendered PDF bytes (not just
        the _build_story header-order mock) — section headers render
        UPPERCASE, which the mocked unit tests above never exercise."""
        md = (
            "# Jane Doe\njane@example.com\n\n"
            "## Professional Summary\nCare worker.\n\n"
            "## Certifications\n- BLS Certified.\n\n"
            "## Awards\n- Employee of the Month\n\n"
            "## References\nAvailable on request.\n\n"
            "## Checks & Clearances\nNational Police Check, valid to 2027.\n"
        )
        pdf = generate_pdf_from_markdown(md)
        text = " ".join(
            p.extract_text() for p in pypdf.PdfReader(io.BytesIO(pdf)).pages
        ).upper()
        assert 0 <= text.find("CHECKS & CLEARANCES") < text.find("REFERENCES")


class TestCertificationsAndChecksPreservesH3Items:
    """Round-2 independent review finding: routing "Certifications & Checks"
    into the EXISTING "certifications" bucket (as the first fix did) sends it
    through _render_certifications, which only keeps "bullet"/"paragraph"
    items and silently drops "h3" items — a real content-loss regression the
    PR's own "no renderer changes" claim explicitly denied making. Fixed by
    giving it its own bucket ("certifications_checks") that falls through to
    the generic fallback instead, which preserves every item type."""

    def test_certifications_and_checks_is_not_merged_into_certifications_bucket(self):
        assert parsing._SECTION_ALIASES["certifications & checks"] != "certifications"

    def test_h3_subheading_survives_end_to_end(self):
        """Verified against real rendered PDF bytes: before the fix, this
        exact input dropped "National Police Check" while its orphaned body
        ("Valid to 2027.") survived with no context — actively misleading."""
        md = (
            "# Jane Doe\njane@example.com\n\n"
            "## Certifications & Checks\n"
            "### National Police Check\nValid to 2027.\n\n"
            "- White Card\n"
        )
        pdf = generate_pdf_from_markdown(md)
        text = " ".join(
            p.extract_text() for p in pypdf.PdfReader(io.BytesIO(pdf)).pages
        )
        assert "National Police Check" in text
        assert "Valid to 2027" in text
        assert "White Card" in text


class TestChecksAndClearancesCoexistsWithRegistrationAndLicences:
    """Round-2 review's own fix for "Checks & Clearances" shared the
    "registration" bucket with "Registration & Licences" (reasoning: "the
    same section, just relabelled by content"). Round-3 review found that
    premise false and reproduced real content loss: eval/enforce_w8.py's
    _relabel_registration renames the heading to "Checks & Clearances", then
    eval/contact_line.py's stamp_credentials (which runs AFTER, per
    writers/_impl.py's step ordering) no longer finds a heading matching
    "registration & licences" and appends a FRESH one at the end of the
    document — so both headings legitimately co-exist in the same CV.
    _build_story's duplicate-key merge (sections.py:744-751) keeps only the
    first-seen title and silently discards the second heading, which
    absorbed a genuinely AHPRA-registered nurse's stamped credential line
    under the wrong "Checks & Clearances" header with "Registration &
    Licences" gone entirely. Fixed by giving "Checks & Clearances" its own
    bucket ("registration_checks"), the same pattern already used for
    "Certifications & Checks" vs "certifications"."""

    def test_checks_and_clearances_is_not_merged_into_registration_bucket(self):
        assert parsing._SECTION_ALIASES["checks & clearances"] != "registration"

    def test_both_headings_survive_and_render_end_to_end(self):
        """Verified against real rendered PDF bytes: before this fix, the
        "Registration & Licences" heading vanished from this exact input,
        its AHPRA content silently absorbed under "Checks & Clearances"."""
        md = (
            "# Jane Doe\njane@example.com\n\n"
            "## Professional Summary\nCare worker.\n\n"
            "## Certifications\n- BLS Certified.\n\n"
            "## Checks & Clearances\nNational Police Check, valid to 2027.\n\n"
            "## References\nAvailable on request.\n\n"
            "## Registration & Licences\nAHPRA Registration: 12345 (exp. 2027).\n"
        )
        pdf = generate_pdf_from_markdown(md)
        text = " ".join(
            p.extract_text() for p in pypdf.PdfReader(io.BytesIO(pdf)).pages
        ).upper()
        assert "CHECKS & CLEARANCES" in text
        assert "REGISTRATION & LICENCES" in text
        assert "AHPRA" in text
        assert "NATIONAL POLICE CHECK" in text
        assert text.find("CHECKS & CLEARANCES") < text.find("REFERENCES")
        assert text.find("REGISTRATION & LICENCES") < text.find("REFERENCES")
