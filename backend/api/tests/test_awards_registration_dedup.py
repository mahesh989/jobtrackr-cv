"""C22e: `_registration_section_text` (eval/writers/awards.py) recognised
"credentials & checks" as a Registration & Licences heading alias, but not
"checks & clearances" or "certifications & checks".

`enforce_w8.py::_relabel_registration` renames "## Registration & Licences"
to "## Checks & Clearances" for nursing CVs with only clearances (police
check, NDIS, WWCC, first aid — no genuine AHPRA/RN/EN registration) — the
common case for unregistered care workers. The manual role family
independently restores "## Certifications & Checks" as its own heading name
(C23). Because `_registration_section_text` didn't know either variant, it
returned "" for exactly those CVs, silently disabling
`split_awards_and_certifications`'s dedupe-against-Registration and letting
a credential appear TWICE — once under the relabelled heading, once again
under a separate Certifications entry.
"""
from app.services.eval.writers.awards import (
    _registration_section_text,
    split_awards_and_certifications,
)


class TestRegistrationSectionTextRecognisesRelabelledHeadings:
    def test_checks_and_clearances_is_recognised(self):
        md = "## Checks & Clearances\n\nFirst Aid Certificate (HLTAID011)\n"
        assert "first aid" in _registration_section_text(md)

    def test_certifications_and_checks_is_recognised(self):
        md = "## Certifications & Checks\n\nFirst Aid Certificate (HLTAID011)\n"
        assert "first aid" in _registration_section_text(md)


class TestSplitAwardsDedupesAgainstRelabelledRegistrationSection:
    """REGRESSION (C22e): a credential canonically listed under the
    relabelled Registration heading must still be dropped from a separate
    Certifications entry, exactly as it already is for the unrelabelled
    "## Registration & Licences" heading."""

    def test_credential_duplicated_under_checks_and_clearances_is_dropped_from_certifications(self):
        md = (
            "## Checks & Clearances\n\n"
            "First Aid Certificate (HLTAID011)\n\n"
            "## Certifications\n\n"
            "First Aid Certification\n"
        )
        out = split_awards_and_certifications(md)
        assert out.lower().count("first aid") == 1

    def test_credential_duplicated_under_certifications_and_checks_is_dropped_from_certifications(self):
        md = (
            "## Certifications & Checks\n\n"
            "First Aid Certificate (HLTAID011)\n\n"
            "## Certifications\n\n"
            "First Aid Certification\n"
        )
        out = split_awards_and_certifications(md)
        assert out.lower().count("first aid") == 1

    def test_control_unrelabelled_registration_heading_still_dedupes(self):
        """Same scenario with the ORIGINAL (unrelabelled) heading — proves
        the dedupe mechanism itself works and isolates the alias gap as the
        only difference versus the two regression tests above."""
        md = (
            "## Registration & Licences\n\n"
            "First Aid Certificate (HLTAID011)\n\n"
            "## Certifications\n\n"
            "First Aid Certification\n"
        )
        out = split_awards_and_certifications(md)
        assert out.lower().count("first aid") == 1

    def test_a_genuinely_novel_certification_not_in_registration_is_kept(self):
        """Non-regression guard: the dedupe must stay conservative — an
        unrelated cert must still survive under the relabelled heading."""
        md = (
            "## Checks & Clearances\n\n"
            "First Aid Certificate (HLTAID011)\n\n"
            "## Certifications\n\n"
            "Certificate III in Individual Support\n"
        )
        out = split_awards_and_certifications(md)
        assert "individual support" in out.lower()
