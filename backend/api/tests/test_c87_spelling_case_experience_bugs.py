"""C87 — regression tests for spelling_case.py + experience.py text-transform
bugs (findings #16-21 from the C79 writers/* read-through, documented in
~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo).

  #16 — spelling_case.py's labor(...) pattern misspells "laborious" as
        "labourious". "Laborious" doesn't take a "u" in British/AU
        spelling either (like "laboratory") — the regex's suffix capture
        doesn't know that.

  #17 — canonicalise_body_spelling has no proper-noun protection on H3
        employer/institution lines, unlike its sibling
        normalise_heading_title_case. "### Cancer Treatment Centers of
        America" -> rewritten to "### Cancer Treatment Centres of
        America", silently altering a real employer's name.

  #18 — Hyphenated first/last words in a title-cased phrase lose correct
        leading-word capitalization. _title_case_token hardcodes
        is_first=False, is_last=False for every segment of a hyphenated
        token, so "In-Home Care Assistant" -> "in-Home Care Assistant"
        (stop-word "in" wrongly lowercased despite being the phrase's
        actual first word).

  #19 — _find_role_line can pick up a date range from bullet prose
        instead of the role's actual tenure, if the italic role-line's
        own dates don't parse.

  #20 — Dict-inversion key collision: "Analyse" converts to American
        "Analyzed" instead of "Analysed". Two entries ("analysed" and
        "analyzed") both map to present-tense "Analyse"; inverting the
        dict for past-tense conversion collides and the later one
        (American spelling) wins.

  #21 — _DATE_RANGE_RE's end-token alternation is case-sensitive, missing
        capitalized "Current"/"Now"/"Ongoing". "Mar 2020 - Current" fails
        to match at all, causing a still-current role to be treated as
        ended in March 2020.
"""
from __future__ import annotations

from app.services.eval.writers.experience import (
    _DATE_RANGE_RE,
    _PRESENT_TO_PAST_VERBS,
    _find_role_line,
    _is_present_role,
    normalise_experience_tense,
    sort_experience_chronologically,
)
from app.services.eval.writers.spelling_case import (
    canonicalise_body_spelling,
    normalise_heading_title_case,
)


# ---------------------------------------------------------------------------
# #16 — "laborious" misspelled as "labourious"
# ---------------------------------------------------------------------------


def test_c16_laborious_is_not_mangled():
    out = canonicalise_body_spelling("- Completed the laborious task of updating records.")
    assert "labourious" not in out
    assert "laborious" in out


def test_c16_labor_forms_still_canonicalise():
    """Sanity: genuine labor/labored/laboring forms must still convert —
    this isn't a blanket disabling of the labor->labour substitution."""
    out = canonicalise_body_spelling("- Labored through a difficult roster change.")
    assert "Laboured" in out


# ---------------------------------------------------------------------------
# #17 — H3 proper nouns corrupted by body spelling canonicalisation
# ---------------------------------------------------------------------------


def test_c17_h3_employer_name_not_corrupted():
    md = (
        "## Experience\n\n"
        "### Cancer Treatment Centers of America\n"
        "*Care Coordinator | Jan 2020 – Present*\n"
        "- Provided coordinated care.\n"
    )
    out = canonicalise_body_spelling(md)
    assert "Cancer Treatment Centers of America" in out
    assert "Centres" not in out


def test_c17_body_text_still_canonicalises():
    """Sanity: non-H3 body text must still get British spelling — this
    isn't a blanket disabling of the whole pass."""
    md = "- Organized the medical center's daily roster.\n"
    out = canonicalise_body_spelling(md)
    assert "Organised" in out
    assert "centre" in out.lower()


# ---------------------------------------------------------------------------
# #18 — hyphenated compound loses leading-word title-casing
# ---------------------------------------------------------------------------


def test_c18_hyphenated_first_word_keeps_capital():
    out = normalise_heading_title_case("*In-Home Care Assistant | Jan 2020 – Present*")
    assert "*In-Home Care Assistant" in out
    assert "in-Home" not in out


def test_c18_hyphenated_token_as_the_phrases_last_word_propagates_is_last():
    """_title_case_token is called directly since a natural CV title
    rarely ends in a hyphenated stop-word — this isolates the is_last
    propagation specifically, mirroring the is_first case above."""
    from app.services.eval.writers.spelling_case import _title_case_token

    # "up-to" as the phrase's final token: "to" is a stop-word, so if
    # is_last isn't propagated to the LAST segment, "to" wrongly lowercases
    # even though it's the true final word of the whole phrase.
    out = _title_case_token("up-to", is_first=False, is_last=True)
    assert out == "Up-To"


def test_c18_hyphenated_middle_word_still_lowercases_stopword():
    """Sanity: a stop-word inside a hyphenated MIDDLE segment (not the
    phrase's true first/last word) should still lowercase correctly —
    this isn't a blanket capitalisation of every hyphen segment."""
    out = normalise_heading_title_case("*Person-Centred-And-Focused Care*")
    assert "-And-" not in out
    assert "-and-" in out


# ---------------------------------------------------------------------------
# #19 — _find_role_line falls through to bullet-prose date scanning
# ---------------------------------------------------------------------------


def test_c19_unparseable_role_line_does_not_fall_through_to_bullet_dates():
    """When the italic role line's own dates fail to parse, a bullet
    mentioning an unrelated, genuinely-parseable date range must NOT be
    picked up as the role's tenure."""
    entry_block = [
        "### Sunset Gardens Aged Care",
        "*Assistant in Nursing | Unparseable Dates Here*",
        "- Delivered training programs from Mar 2020 to Dec 2021 across facilities.",
    ]
    idx, parsed = _find_role_line(entry_block)
    assert parsed is None, (
        f"picked up an unrelated date range from bullet prose instead of "
        f"reporting the role line as unparseable: {parsed!r}"
    )


def test_c19_genuine_role_line_still_parses_normally():
    """Sanity: a well-formed italic role line must still parse correctly
    — this isn't a blanket disabling of role-line date parsing."""
    entry_block = [
        "### Sunset Gardens Aged Care",
        "*Assistant in Nursing | Jan 2020 – Present*",
        "- Provided personal care to residents.",
    ]
    idx, parsed = _find_role_line(entry_block)
    assert parsed is not None
    assert idx == 1


def test_c19_no_italic_line_still_falls_back_to_scanning():
    """Sanity: an entry with NO italic role line at all (a different
    production shape) should still fall back to scanning for a date."""
    entry_block = [
        "### Sunset Gardens Aged Care",
        "Assistant in Nursing, Jan 2020 – Present",
        "- Provided personal care to residents.",
    ]
    idx, parsed = _find_role_line(entry_block)
    assert parsed is not None


# ---------------------------------------------------------------------------
# #20 — dict-inversion collision: Analyse -> Analyzed instead of Analysed
# ---------------------------------------------------------------------------


def test_c20_present_to_past_analyse_uses_british_spelling():
    assert _PRESENT_TO_PAST_VERBS.get("analyse") == "Analysed"


def test_c20_end_to_end_tense_normaliser_uses_british_spelling():
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care\n"
        "*Assistant in Nursing | Jan 2020 – Dec 2022*\n"
        "- Analyse resident care plans for accuracy.\n"
    )
    out = normalise_experience_tense(md)
    assert "Analysed" in out
    assert "Analyzed" not in out


# ---------------------------------------------------------------------------
# #21 — case-sensitive Current/Now/Ongoing end-token
# ---------------------------------------------------------------------------


def test_c21_capitalized_current_matches_date_range():
    assert _DATE_RANGE_RE.search("Mar 2020 – Current") is not None


def test_c21_capitalized_ongoing_matches_date_range():
    assert _DATE_RANGE_RE.search("Mar 2020 – Ongoing") is not None


def test_c21_still_current_role_sorts_as_ongoing_not_ended():
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care\n"
        "*Assistant in Nursing | Mar 2020 – Current*\n"
        "- Provided personal care.\n\n"
        "### Older Employer\n"
        "*Support Worker | Jan 2015 – Dec 2018*\n"
        "- Provided personal care.\n"
    )
    entry_block = ["### Sunset Gardens Aged Care", "*Assistant in Nursing | Mar 2020 – Current*"]
    idx, parsed = _find_role_line(entry_block)
    assert parsed is not None
    assert _is_present_role(parsed)
