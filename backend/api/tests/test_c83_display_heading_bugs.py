"""C83 — regression tests for _apply_display_heading (finding #2 from the
C79 writers/* read-through, documented in ~/.claude/plans/C78-C81-INSTRUCTIONS.md,
not in this repo).

`_apply_display_heading` picks between "## Career Highlights" (YEARS
framing) and "## Professional Summary" (BREADTH framing) based on whether
S1's prose mentions a years figure. Two bugs:

  #2a — `s1 = prose.split(".", 1)[0]` truncates at the FIRST period in the
        prose, not the first SENTENCE boundary. A decimal years figure like
        "12.5+ years" truncates to "with 12" (losing "years" entirely), so
        `_YEARS_FIGURE_RE` never matches and the wrong heading is picked
        even though the CV genuinely states a years figure.

  #2b — the function runs once, inside `_writer_w8_integrated`, BEFORE
        `verify_claims`. `_writer_w8_verified` never re-runs it afterward,
        unlike every other cosmetic/structural pass in that function's
        post-verify chain — so a verify_claims rewrite of S1 (which can add
        or remove a years figure) can desync the displayed heading from the
        final prose.
"""
from __future__ import annotations

from app.services.eval.writers import _impl
from tests.test_post_verify_invariants import assert_invariant_runs_after_verify


def test_c83a_decimal_years_figure_picks_career_highlights_not_professional_summary():
    """'12.5+ years' must still be recognised as a years figure — the
    truncation-at-first-period bug loses everything after 'with 12'."""
    md = (
        "## Professional Summary\n\n"
        "Dedicated aged care worker with 12.5+ years of experience across "
        "residential facilities, specialising in dementia care.\n\n"
        "## Experience\n\n- Did care.\n"
    )
    out = _impl._apply_display_heading(md)
    assert out.startswith("## Career Highlights"), (
        f"expected the years-figure heading, got:\n{out.splitlines()[0]!r}"
    )


def test_c83a_non_years_prose_still_picks_professional_summary():
    """Sanity: a genuinely years-free S1 should still pick the BREADTH
    heading — this isn't a blanket flip to always picking Career Highlights."""
    md = (
        "## Career Highlights\n\n"
        "Dedicated aged care worker with a strong background across "
        "residential facilities, specialising in dementia care.\n\n"
        "## Experience\n\n- Did care.\n"
    )
    out = _impl._apply_display_heading(md)
    assert out.startswith("## Professional Summary"), (
        f"expected the breadth heading, got:\n{out.splitlines()[0]!r}"
    )


def test_c83a_plain_integer_years_figure_still_works():
    """Sanity: the non-decimal case (already working) must not regress."""
    md = (
        "## Professional Summary\n\n"
        "Dedicated aged care worker with 12+ years of experience across "
        "residential facilities.\n\n"
        "## Experience\n\n- Did care.\n"
    )
    out = _impl._apply_display_heading(md)
    assert out.startswith("## Career Highlights")


def test_c83b_writer_w8_verified_reruns_display_heading_after_verify_claims():
    """_apply_display_heading must run again inside _writer_w8_verified,
    AFTER verify_claims, so a verify_claims rewrite of S1 can't desync the
    displayed heading from the final prose.

    Asserted through the declared invariant set: the pass is a member and
    the set is swept after verify_claims (and after the summary-floor AI
    rewrite too — see tests/test_post_verify_invariants.py).
    """
    assert_invariant_runs_after_verify("apply_display_heading")
