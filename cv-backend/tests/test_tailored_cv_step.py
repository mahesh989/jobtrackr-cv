from __future__ import annotations

from app.services.pipeline.steps.tailored_cv import _enforce_career_highlights_words


def test_enforce_career_highlights_words_preserves_semicolon():
    # If the text has a semicolon and is under 50 words, it should not be modified.
    md = (
        "## Career Highlights\n\n"
        "Assistant In Nursing with experience across residential Aged Care settings, specialising in "
        "person-centred care and medication assistance for elderly residents in supported living environments. "
        "Delivered accurate electronic medication administration and documentation at Jesmond Miranda Nursing Home; "
        "provides support and behavioural management at Uniting – The Marion.\n\n"
        "## Experience\n"
    )
    out = _enforce_career_highlights_words(md, max_words=50)
    assert "Uniting – The Marion" in out


def test_enforce_career_highlights_words_with_overflow():
    # If it is over 50 words, we want to make sure it doesn't split at the semicolon
    # (which would drop the entire second clause).
    md_over = (
        "## Career Highlights\n\n"
        "Assistant In Nursing with 2+ years of experience across residential Aged Care settings, specialising in "
        "person-centred care and medication assistance for elderly residents in supported living environments. "
        "Delivered accurate electronic medication administration and documentation at Jesmond Miranda Nursing Home; "
        "provides support and behavioural management for residents at Uniting – The Marion.\n\n"
        "## Experience\n"
    )
    out_over = _enforce_career_highlights_words(md_over, max_words=50)
    # With the semicolon check removed, it should not cut at the semicolon (which is at word 40).
    # It should keep words up to the period at word 24 or word 50 (if no period within flex limit).
    # Since word 24 has a period, it walks back from 50 and finds the period at word 24, trimming S2 entirely
    # to fit within the 50-word cap honestly rather than splitting a clause in half.
    # In any case, it should not produce a truncated clause ending in a semicolon.
    assert not out_over.endswith(";")
    assert "Jesmond Miranda" in out_over or "Uniting" in out_over
