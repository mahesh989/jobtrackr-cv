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

    def test_checks_and_clearances_with_the_word_and_is_recognised(self):
        # C22i: paired with _GROUNDED_SECTION_WORDS, which already lists
        # BOTH "checks & clearances" and "checks and clearances" — an
        # "&"->"and" LLM typography normalisation is plausible for this
        # exact phrase elsewhere in this same file, not a new assumption.
        md = "## Checks and Clearances\n\nFirst Aid Certificate (HLTAID011)\n"
        assert "first aid" in _registration_section_text(md)

    def test_certifications_and_checks_with_the_word_and_is_recognised(self):
        md = "## Certifications and Checks\n\nFirst Aid Certificate (HLTAID011)\n"
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


class TestAdjacentBulletsGroupedAsSeparateEntries:
    """REGRESSION (C22h, found during C22e's independent review — flagged as
    the highest-value open item in the whole C22 family, pre-existing under
    the ORIGINAL "## Registration & Licences" heading too, not caused by any
    prior C22 fix): the entry-grouping loop in split_awards_and_certifications
    treated ANY line starting with a bullet marker as a CONTINUATION of the
    current entry whenever `current` was non-empty — including a second,
    unrelated bullet with no blank line separating it from the first. Two
    genuinely distinct certifications listed as adjacent bullets (a very
    common LLM output shape) were merged into ONE entry before
    classification, so a SINGLE duplicate-credential match against the
    merged blob dropped the WHOLE run — silently deleting a real, non-
    duplicate credential the candidate holds alongside the one that was
    correctly a duplicate."""

    def test_a_duplicate_bullet_no_longer_drops_the_next_distinct_bullet(self):
        md = (
            "## Registration & Licences\n\n"
            "First Aid Certificate (HLTAID011)\n\n"
            "## Certifications\n\n"
            "- First Aid Certificate\n"
            "- Advanced Cardiac Life Support Certificate\n"
        )
        out = split_awards_and_certifications(md)
        # The duplicate bullet is still correctly dropped...
        assert out.lower().count("first aid") == 1  # only the Registration copy
        # ...but the adjacent, genuinely distinct bullet must SURVIVE, not
        # be silently deleted as collateral damage of the merge.
        assert "advanced cardiac life support" in out.lower()

    def test_two_non_duplicate_adjacent_bullets_both_survive_as_separate_entries(self):
        md = (
            "## Certifications\n\n"
            "- Advanced Cardiac Life Support Certificate\n"
            "- Certificate III in Individual Support\n"
        )
        out = split_awards_and_certifications(md)
        assert "advanced cardiac life support" in out.lower()
        assert "individual support" in out.lower()

    def test_indented_continuation_line_still_merges_into_the_same_bullet_entry(self):
        # A genuinely wrapped continuation of ONE bullet's own text (indented,
        # not a new top-level bullet) must still merge — this fix narrows
        # the bug to top-level bullet-after-bullet only, not all
        # continuations.
        md = (
            "## Certifications\n\n"
            "- Advanced Cardiac Life Support Certificate\n"
            "  issued by St John Ambulance\n"
        )
        out = split_awards_and_certifications(md)
        assert "issued by st john ambulance" in out.lower()
