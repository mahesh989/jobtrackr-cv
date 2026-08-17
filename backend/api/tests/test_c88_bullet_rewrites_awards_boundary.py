"""C88 — regression test for a bullet_rewrites.py Awards-section boundary bug
(finding #22 from the C79 writers/* read-through, documented in
~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo).

Original finding: `_is_experience_bullet` only excluded the Skills section
(never computed an Experience-section boundary), so Awards bullets could be
targeted by `_targeted_bullet_rewrites` and rewritten as if they were
job-duty bullets — corrupting a factual award entry.

Already fixed, incidentally, by C67 (`fix(api): close final CV honesty
bypasses`, commit 972fc3a0): `_is_experience_bullet` now checks membership
against `verify._collect_bullets`'s scoped-to-`_VERIFY_SECTIONS` line set
(Experience/Projects only — Awards was never in that set) instead of a
Skills-only exclusion. This test locks that behaviour in with coverage for
the specific scenario this finding described, which C67's own test suite
(`test_c67_honesty_chain.py`) didn't exercise.
"""
from __future__ import annotations

from app.services.eval.verify import _collect_bullets


def test_awards_bullets_are_never_collected_as_rewrite_targets():
    """The set _targeted_bullet_rewrites builds its verifiable-line index
    from (verify._collect_bullets) must never include an Awards bullet,
    even though Awards entries use the same bullet markers as Experience."""
    md = (
        "## Experience\n\n"
        "### Sunset Gardens Aged Care | Sydney, NSW\n"
        "*Assistant in Nursing | Jan 2024 – Present*\n"
        "- Provided personal care to residents.\n\n"
        "## Awards\n\n"
        "### Staff Excellence Award\n"
        "- Recognised for outstanding teamwork and reliability.\n"
    )
    collected = _collect_bullets(md)
    texts = [text for _idx, text in collected]
    assert "Provided personal care to residents." in texts
    assert not any("teamwork" in t for t in texts), (
        "an Awards bullet was collected as a rewrite target — it would be "
        "eligible for _targeted_bullet_rewrites to corrupt into duty-style prose"
    )
