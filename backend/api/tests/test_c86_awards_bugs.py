"""C86 — regression tests for awards.py bugs (findings #13, #14, #15 from
the C79 writers/* read-through, documented in
~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo).

  #13 — Award description silently truncated at first comma in the
        "swapped shape" (blank-line-separated) case. When verify_claims
        promotes an award's description to its own ### heading with a
        blank line before it, _split_award_name_org blind-splits the
        description on the first comma. "Recognised for hard work, caring
        nature, and positive attitude." -> only "Recognised for hard
        work" survives; the rest is silently dropped (the merge step only
        reads entry.get("name"), never entry.get("org") where the rest
        landed).

  #14 — A mundane CV sentence containing a stray credential keyword can
        be fabricated into a new Awards/Certifications entry. A <=5-word
        non-bullet line containing ANY _CRED_KEYWORDS token (includes
        generic words like "recognition", "development", "check") is
        misclassified as a section heading, and collecting=True persists
        across blank lines, sweeping in whatever prose follows.

  #15 — Apostrophe-form "Driver's Licence" isn't recognized as a
        duplicate of the Registration & Licences section entry. Dedup
        anchors list "driver licence"/"drivers license" but not the
        apostrophe form, which is the standard AU spelling.
"""
from __future__ import annotations

import pytest

from app.services.eval.writers.awards import (
    _credential_already_in_registration,
    _extract_original_credentials,
    _is_cred_heading,
    _normalise_awards_entries,
)
from app.services.eval.writers.awards_parsing import _split_award_name_org


# ---------------------------------------------------------------------------
# #13 — comma-split swapped-shape description truncation
# ---------------------------------------------------------------------------


def test_c13_swapped_shape_description_survives_the_comma_intact():
    """The exact #13 repro: verify_claims promotes the description to its
    own ### heading, blank-line-separated from the name+org entry above."""
    markdown = (
        "## Awards\n\n"
        "* Staff Excellence Award – The Jesmond Group\n\n"
        "### Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = _normalise_awards_entries(markdown)
    assert "Recognised for hard work, caring nature, and positive attitude." in out
    assert "caring nature" in out


def test_c13_genuine_dash_split_name_org_still_works():
    """Sanity: a genuine 'Name – Org' heading with a real org name
    (unrelated to description language) must still split correctly —
    this isn't a blanket disabling of the dash/comma split."""
    name, org = _split_award_name_org("Staff Excellence Award – The Jesmond Group")
    assert name == "Staff Excellence Award"
    assert org == "The Jesmond Group"


def test_c13_award_name_starting_with_a_description_prefix_word_still_dash_splits():
    """Round-1 review: the description-prefix guard must only gate the
    COMMA branch, not the dash branch — a genuine award/org pair whose
    name happens to start with a description-prefix word ("Honoured...",
    "For...") must still split on the dash correctly."""
    name, org = _split_award_name_org("Honoured Service Award – City Council")
    assert name == "Honoured Service Award"
    assert org == "City Council"

    name, org = _split_award_name_org("For Excellence in Care – St Vincent's")
    assert name == "For Excellence in Care"
    assert org == "St Vincent's"


# ---------------------------------------------------------------------------
# #14 — stray credential keyword fabricates a new heading + sweeps prose
# ---------------------------------------------------------------------------


def test_c14_experience_sentence_with_stray_keyword_is_not_swept_as_credentials():
    """The exact #14 repro: 'Recognition program participant, 2019' inside
    an Experience-section block must NOT be misclassified as a
    Certifications-like heading — it's a normal CV sentence."""
    cv_text = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care\n"
        "*Assistant in Nursing | Jan 2019 – Present*\n"
        "Recognition program participant, 2019\n"
        "Manager noted strong attendance and reliability throughout the year.\n"
    )
    entries = _extract_original_credentials(cv_text)
    assert "Manager noted strong attendance and reliability throughout the year." not in entries


def test_c14_genuine_certifications_heading_still_collects_entries():
    """Sanity: a genuine Certifications heading (even without markdown
    '## ' prefix, the plain-text CV case this function exists for) must
    still collect its real entries — this isn't a blanket disabling."""
    cv_text = (
        "Certifications\n"
        "First Aid Certificate, 2023\n"
        "CPR Certificate, 2023\n"
    )
    entries = _extract_original_credentials(cv_text)
    assert "First Aid Certificate, 2023" in entries
    assert "CPR Certificate, 2023" in entries


class TestCredHeadingRejectsSentencesNotJustCommaDigitShape:
    """Round-1 independent review found the original #14 fix (rejecting
    only a comma-immediately-followed-by-a-digit shape) was too narrow —
    it closed one specific lexical form but left the general problem
    open: ANY short (<=5 word) sentence containing a stray _CRED_KEYWORDS
    token still misfired as a heading. Verified end-to-end exploitable:
    'Supported staff recognition programs' followed by ordinary sentences
    got swept and could be injected as fabricated Awards entries. Fixed
    by requiring EVERY token in a bare-label heading to be a credential
    keyword, a connector, or a digit — not merely CONTAIN one."""

    def test_supported_staff_recognition_programs_is_not_a_heading(self):
        assert not _is_cred_heading("Supported staff recognition programs")

    def test_ongoing_professional_development_is_not_a_heading(self):
        assert not _is_cred_heading("Ongoing professional development")

    def test_police_check_completed_2023_sentence_is_not_a_heading(self):
        assert not _is_cred_heading("Police check completed 2023")

    def test_received_recognition_for_teamwork_is_not_a_heading(self):
        assert not _is_cred_heading("Received recognition for teamwork")

    def test_handled_licence_renewal_admin_is_not_a_heading(self):
        assert not _is_cred_heading("Handled licence renewal admin")

    def test_end_to_end_adversarial_sentence_is_not_swept_into_credentials(self):
        cv_text = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care\n"
            "*Assistant in Nursing | Jan 2019 – Present*\n"
            "Supported staff recognition programs\n"
            "Assisted the manager in preparing award nominations for other "
            "team members.\n"
            "Coordinated the annual prize ceremony logistics for the "
            "facility.\n"
        )
        entries = _extract_original_credentials(cv_text)
        assert not any("award nominations" in e for e in entries)
        assert not any("prize ceremony" in e for e in entries)

    def test_genuine_bare_label_headings_still_recognised(self):
        """Sanity: plausible real bare-label Certifications/Awards
        headings — including ones with connectors, dates, and multiple
        credential words — must still be recognised."""
        for heading in (
            "Certifications",
            "Awards & Recognition",
            "Awards, Honours & Recognition",
            "Licences, Checks & Clearances",
            "Certifications (2020-2024)",
            "Other Certifications",
        ):
            assert _is_cred_heading(heading), f"expected {heading!r} to be a heading"

    def test_round_2_review_recall_regressions_are_fixed(self):
        """Round-2 independent review found the all-of-tokens tightening
        for #14 lost recall on common real AU aged-care/nursing bare-label
        headings — "police"/"working"/"children"/"training"/"courses"/
        "memberships"/"with" weren't in either _CRED_KEYWORDS or
        _CRED_HEADING_CONNECTORS, so these genuine headings silently
        stopped being recovered by ensure_awards (a missed-recovery
        regression, never a fabrication one, but still a real loss)."""
        for heading in (
            "Police Checks & Clearances",
            "National Police Check",
            "Working with Children Check",
            "Training & Certifications",
            "Certifications and Training",
            "Courses and Certifications",
            "Professional Memberships",
        ):
            assert _is_cred_heading(heading), f"expected {heading!r} to be a heading"

    def test_round_2_review_new_words_do_not_reopen_sentence_false_positives(self):
        """The new credential/connector words (police, working, children,
        training, courses, memberships, with) must not let a genuine
        Experience-section SENTENCE built from them false-positive as a
        heading."""
        for sentence in (
            "Working with children daily",
            "Conducted national police checks for new starters",
            "Completed police check training courses",
            "Attended training courses regularly",
            "Assisted residents with daily care",
            "Worked with the team",
        ):
            assert not _is_cred_heading(sentence), f"{sentence!r} wrongly treated as a heading"

    def test_connector_words_alone_are_not_a_heading(self):
        """Round-3 review: a line made ENTIRELY of connector words, with
        zero genuine credential-domain content, must not pass — the
        all-of-tokens gate alone let 'Professional'/'Other'/'Current'/
        'Key' wrongly return True."""
        for word in ("Professional", "Other", "Current", "Key", "The"):
            assert not _is_cred_heading(word), f"{word!r} wrongly treated as a heading"


# ---------------------------------------------------------------------------
# #15 — apostrophe-form Driver's Licence dedup miss
# ---------------------------------------------------------------------------


def test_c15_apostrophe_drivers_licence_matches_registration_entry():
    registration_blob = "current driver's licence (nsw)\nfirst aid certificate\n"
    assert _credential_already_in_registration("Driver's Licence", registration_blob)


def test_c15_apostrophe_entry_matches_non_apostrophe_registration():
    """The apostrophe can appear on either side — entry apostrophe'd,
    registration section plain, or vice versa."""
    registration_blob = "current drivers licence\n"
    assert _credential_already_in_registration("Driver's Licence (NSW)", registration_blob)


def test_c15_non_duplicate_credential_still_not_matched():
    """Sanity: an unrelated credential must not false-positive as a
    duplicate — this isn't a blanket match-everything change."""
    registration_blob = "current driver's licence (nsw)\n"
    assert not _credential_already_in_registration("First Aid Certificate", registration_blob)


# ---------------------------------------------------------------------------
# Spelling-blind description dedupe (found by a live re-analysis, 2026-08-22,
# while verifying the invariant-set refactor — docs/POST_VERIFY_INVARIANTS.md)
# ---------------------------------------------------------------------------


_CV_WITH_AMERICAN_AWARD = """\
Recognition
Staff Excellence Award, Jesmond Miranda Nursing Home Miranda, NSW, Australia
Recognized for hard work, caring nature, and positive attitude August 2025
"""


def test_ensure_awards_does_not_duplicate_an_already_britishised_description():
    """The source CV's spelling must not defeat the duplicate check.

    ensure_awards re-adds award content from the SOURCE CV, which carries the
    author's own spelling ("Recognized…"). By the time it runs, the tailored
    document has already been through canonicalise_body_spelling
    ("Recognised…"). A literal comparison sees two different sentences and
    appends the CV copy — and the duplicate then survives, because
    _dedupe_award_description_sentences already ran and the later spelling
    pass is what makes the two identical.

    Observed live: one Awards bullet rendered "Recognised for hard work,
    caring nature, and positive attitude." twice.
    """
    from app.services.eval.writers.awards import (
        _normalise_awards_entries,
        ensure_awards,
    )

    md = (
        "## Awards\n\n"
        "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)\n"
        "  Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = _normalise_awards_entries(ensure_awards(md, _CV_WITH_AMERICAN_AWARD))
    assert out.lower().count("caring nature") == 1, out


def test_award_description_dedupe_is_stable_across_repeated_passes():
    """The awards passes run on both sides of verify_claims now, so a
    single non-idempotent append compounds instead of self-correcting."""
    from app.services.eval.writers.awards import (
        _normalise_awards_entries,
        ensure_awards,
    )

    md = (
        "## Awards\n\n"
        "* Staff Excellence Award, Jesmond Miranda Nursing Home (August 2025)\n"
        "  Recognised for hard work, caring nature, and positive attitude.\n"
    )
    out = md
    for _ in range(3):
        out = _normalise_awards_entries(ensure_awards(out, _CV_WITH_AMERICAN_AWARD))
    assert out.lower().count("caring nature") == 1, out


@pytest.mark.parametrize(
    "desc,expected_sentences",
    [
        # The writer embellished the CV's sentence; the CV copy is a strict
        # subset of it and must be dropped despite the spelling difference.
        (
            "Recognised for hard work, reliability, caring nature, and positive "
            "attitude. Recognized for hard work, caring nature, and positive attitude.",
            1,
        ),
        (
            "Recognised for hard work, caring nature, positive attitude and "
            "commitment to resident wellbeing and engagement. Recognized for hard "
            "work, caring nature, and positive attitude.",
            1,
        ),
        # C85 (#12) must still hold: two sentences naming DIFFERENT traits are
        # not duplicates, and folding spelling must not start merging them.
        (
            "Recognised for excellent teamwork and reliability. "
            "Recognised for excellent teamwork and punctuality.",
            2,
        ),
    ],
)
def test_award_description_dedupe_folds_spelling(desc: str, expected_sentences: int):
    """British/American spelling must not defeat the strict-subset dedupe.

    The source CV carries the author's spelling ("Recognized…") while the
    writer's own sentence is already British ("Recognised…"), so the token
    sets differ and the subset test fails. canonicalise_body_spelling then
    makes the two near-identical LATER in the chain, with no dedupe left to
    run. Found in 3 of 9 CVs in a bulk re-analysis — the single-JD run that
    preceded it was clean, which is exactly why the bulk bar exists
    (docs/POST_VERIFY_INVARIANTS.md).
    """
    from app.services.eval.writers.awards_parsing import (
        _dedupe_award_description_sentences,
    )

    out = _dedupe_award_description_sentences(desc)
    assert len([s for s in out.split(". ") if s.strip()]) == expected_sentences, out
