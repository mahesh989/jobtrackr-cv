"""Tests for _ensure_summary_anchors_both_employers in writers/_impl.py.

When a CV has 2+ multi-month (nameable-anchor) employers, the summary's
Sentence 2 must name BOTH. The model sometimes cherry-picks one (e.g. names
only the employer that gave an award) and drops the other; the deterministic
_enforce_company_anchor net cannot repair that (it considers the summary
"already anchored" the moment one employer appears). This corrective retry
detects the gap and re-asks the model once, accepting only a compliant rewrite.

Key invariants:
1. No retry (no AI call) when the CV has <2 multi-month employers.
2. No retry when the summary already names both top-2 employers.
3. Retry fires when only one of two anchors is named; a compliant rewrite
   (names both, two sentences) is accepted.
4. A rewrite that still fails to name both employers is rejected (original kept).
5. AI failures are swallowed — original kept.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from app.services.eval.writers._impl import _ensure_summary_anchors_both_employers


# Two anchored employers in the CV (both carry multi-month date spans). The
# Anglicare line is a true 120-hour placement → excluded as an anchor.
CV_TEXT = """\
### Uniting | Leichhardt, NSW | Mar 2026 – Present
- AIN (Casual) providing person-centred care.

### The Jesmond Group | Miranda, NSW | May 2025 – June 2026
- AIN serving as primary Medication Assistant.

### Anglicare Mildred Symons House | Jannali, NSW | Aged Care Placement (120 hours)
- Delivered dementia care.
"""

# Summary that names ONLY The Jesmond Group (via the award), dropping Uniting.
MD_ONE_ANCHOR = """\
## Career Highlights

Assistant in Nursing with experience in residential aged care, delivering person-centred care and activities of daily living for older people. Recognised with a Staff Excellence Award at The Jesmond Group for hard work and a caring nature.

## Professional Experience
- x
"""

# Summary that already names BOTH anchors.
MD_BOTH_ANCHORS = """\
## Career Highlights

Assistant in Nursing supporting older residents with person-centred care and dementia support. Delivered electronic medication administration at The Jesmond Group; provides daily living support at Uniting.

## Professional Experience
- x
"""


def _client(return_value: str) -> MagicMock:
    client = MagicMock()
    client.complete = AsyncMock(return_value=return_value)
    return client


def _await(coro):
    # Reuse the shared loop (matches the other async tests in this suite).
    # NOT asyncio.run() — that closes/unsets the global loop and breaks tests
    # that rely on asyncio.get_event_loop().run_until_complete().
    return asyncio.get_event_loop().run_until_complete(coro)


def _run(md: str, client: MagicMock) -> str:
    return _await(
        _ensure_summary_anchors_both_employers(
            client, md, system_prompt="sys", cv_text=CV_TEXT, jd_text="jd",
        )
    )


def test_no_retry_when_fewer_than_two_employers():
    client = _client("should not be used")
    cv_single = "### Uniting | Leichhardt, NSW | Mar 2026 – Present\n- AIN.\n"
    out = _await(
        _ensure_summary_anchors_both_employers(
            client, MD_ONE_ANCHOR, system_prompt="s", cv_text=cv_single, jd_text="jd",
        )
    )
    assert out == MD_ONE_ANCHOR
    client.complete.assert_not_called()


def test_no_retry_when_both_already_named():
    client = _client("should not be used")
    out = _run(MD_BOTH_ANCHORS, client)
    assert out == MD_BOTH_ANCHORS
    client.complete.assert_not_called()


def test_retry_accepted_when_rewrite_names_both():
    rewrite = (
        "Assistant in Nursing supporting older residents with person-centred care "
        "and dementia support. Delivered electronic medication administration at "
        "The Jesmond Group; provides daily living support at Uniting."
    )
    client = _client(rewrite)
    out = _run(MD_ONE_ANCHOR, client)
    client.complete.assert_called_once()
    assert "Uniting" in out and "The Jesmond Group" in out
    # award-shaped S2 has been replaced
    assert "Staff Excellence Award" not in out


def test_retry_rejected_when_rewrite_still_misses_an_anchor():
    # Rewrite still names only Jesmond → reject, keep original.
    bad = (
        "Assistant in Nursing supporting older residents. Delivered medication "
        "administration at The Jesmond Group for elderly residents."
    )
    client = _client(bad)
    out = _run(MD_ONE_ANCHOR, client)
    client.complete.assert_called_once()
    assert out == MD_ONE_ANCHOR


def test_ai_failure_keeps_original():
    client = MagicMock()
    client.complete = AsyncMock(side_effect=RuntimeError("boom"))
    out = _run(MD_ONE_ANCHOR, client)
    assert out == MD_ONE_ANCHOR
