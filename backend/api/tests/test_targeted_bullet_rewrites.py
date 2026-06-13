"""Tests for _targeted_bullet_rewrites in writers.py.

The function runs focused single-bullet LLM calls for inject_as_extension
keywords that the composition LLM missed. Key invariants:

1. Zero calls when all approved keywords are already present.
2. One call per missed keyword, fired concurrently.
3. The rewritten bullet replaces the original in the markdown.
4. Keywords present in the markdown are not re-processed.
5. Entries with no evidence are skipped (no call made).
6. LLM failures are swallowed — original bullet kept.
"""
from __future__ import annotations

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Import the function under test
# ---------------------------------------------------------------------------
from app.services.eval.writers import _targeted_bullet_rewrites


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_client(return_value: str = "Rewritten bullet text here.") -> MagicMock:
    """Mock AIClient whose complete() returns the given string."""
    client = MagicMock()
    client.complete = AsyncMock(return_value=return_value)
    return client


def _feasibility(extensions: list) -> dict:
    return {"feasibility_plan": {"inject_as_extension": extensions}}


_BASE_MD = """\
## Professional Summary

Experienced care worker in residential aged care settings.

## Experience

Employer One
Care Worker
- Provide personal care to residents including bathing and dressing.
- Monitor wellbeing of residents and report changes to nursing staff.

Employer Two
Assistant in Nursing
- Manage medication administration using BESTMed system.
- Support residents with mobility and transfers.

## Skills

- **Care Skills:** Personal Care, Dementia Care
- **Soft Skills:** Teamwork, Communication
- **Other Skills:** BESTMed
"""


# ---------------------------------------------------------------------------
# Core behaviour
# ---------------------------------------------------------------------------

class TestTargetedBulletRewritesNoMiss:

    def test_no_calls_when_all_keywords_present(self):
        """When every approved keyword already appears in the markdown, no LLM
        calls should be made and the markdown is returned unchanged."""
        client = _make_client()
        feasibility = _feasibility([
            {
                "keyword": "personal care",
                "evidence": "Provide personal care to residents",
                "suggested_rewrite": "irrelevant",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        client.complete.assert_not_called()
        assert result == _BASE_MD

    def test_no_calls_when_no_extensions(self):
        """Empty inject_as_extension → no LLM calls, markdown unchanged."""
        client = _make_client()
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, _feasibility([]))
        )
        client.complete.assert_not_called()
        assert result == _BASE_MD

    def test_no_calls_when_feasibility_none(self):
        """None feasibility → no LLM calls, markdown unchanged."""
        client = _make_client()
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, None)
        )
        client.complete.assert_not_called()
        assert result == _BASE_MD


class TestTargetedBulletRewritesMiss:

    def test_one_call_for_one_missed_keyword(self):
        """A single missed keyword triggers exactly one LLM call."""
        client = _make_client("Provide person-centred home care to residents including bathing and dressing.")
        feasibility = _feasibility([
            {
                "keyword": "home care",
                "evidence": "provide personal care to residents bathing dressing",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        client.complete.assert_called_once()
        assert "home care" in result.lower()

    def test_rewritten_bullet_replaces_original(self):
        """The original bullet text is replaced by the LLM's rewrite (keyword landed)."""
        rewrite = ("Manage medication administration using BESTMed, demonstrating "
                   "basic smartphone knowledge on handheld devices.")
        client = _make_client(rewrite)
        feasibility = _feasibility([
            {
                "keyword": "basic smartphone knowledge",
                "evidence": "Manage medication administration using BESTMed system",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        assert rewrite in result
        # Original bullet should be gone
        assert "Manage medication administration using BESTMed system." not in result

    def test_rewrite_dropped_when_keyword_does_not_land(self):
        """If the LLM paraphrases WITHOUT the keyword, the rewrite is dropped and
        the original bullet is preserved (no fidelity loss for zero benefit)."""
        # Rewrite does NOT contain "basic smartphone knowledge"
        client = _make_client("Manage medication administration using BESTMed accurately.")
        feasibility = _feasibility([
            {
                "keyword": "basic smartphone knowledge",
                "evidence": "Manage medication administration using BESTMed system",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        client.complete.assert_called_once()  # call WAS made
        # but original preserved because keyword never landed
        assert "Manage medication administration using BESTMed system." in result
        assert "Manage medication administration using BESTMed accurately." not in result

    def test_two_keywords_same_evidence_single_call_no_collision(self):
        """Two keywords with identical evidence target the SAME bullet → exactly
        ONE LLM call incorporating both (the v228 collision bug). Both land."""
        rewrite = ("Provide person-centred home care support for older people, "
                   "supporting retirement living residents with daily living "
                   "activities such as bathing, dressing, and meal assistance.")
        client = _make_client(rewrite)
        shared_evidence = "Provide personal care to residents bathing dressing meal assistance"
        feasibility = _feasibility([
            {"keyword": "home care support for older people", "evidence": shared_evidence},
            {"keyword": "supporting retirement living residents", "evidence": shared_evidence},
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        # CRITICAL: one call, not two — no collision
        client.complete.assert_called_once()
        # Both keywords present in the final markdown
        assert "home care support for older people" in result.lower()
        assert "supporting retirement living residents" in result.lower()

    def test_two_missed_keywords_two_calls(self):
        """Two missed keywords → two concurrent LLM calls."""
        client = _make_client("Rewritten bullet.")
        feasibility = _feasibility([
            {
                "keyword": "home care",
                "evidence": "Provide personal care to residents",
            },
            {
                "keyword": "basic smartphone knowledge",
                "evidence": "Manage medication administration using BESTMed system",
            },
        ])
        asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        assert client.complete.call_count == 2

    def test_present_keyword_skipped_missed_keyword_rewritten(self):
        """Only the missing keyword triggers a call; the present one is skipped."""
        client = _make_client("Rewritten bullet for home care.")
        feasibility = _feasibility([
            {
                "keyword": "personal care",   # present in markdown
                "evidence": "irrelevant",
            },
            {
                "keyword": "home care",        # absent from markdown
                "evidence": "Provide personal care to residents",
            },
        ])
        asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        # Only one call (for "home care")
        assert client.complete.call_count == 1
        # The call should mention "home care"
        call_kwargs = client.complete.call_args[1] if client.complete.call_args[1] else {}
        call_args = client.complete.call_args[0] if client.complete.call_args[0] else ()
        call_text = str(call_kwargs) + str(call_args)
        assert "home care" in call_text.lower()


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestTargetedBulletRewritesEdgeCases:

    def test_entry_without_evidence_skipped(self):
        """An entry with no evidence field makes no LLM call (can't find bullet)."""
        client = _make_client()
        feasibility = _feasibility([
            {"keyword": "home care", "evidence": ""}
        ])
        asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        client.complete.assert_not_called()

    def test_llm_failure_keeps_original_bullet(self):
        """If the LLM call raises an exception, the original bullet is preserved."""
        client = MagicMock()
        client.complete = AsyncMock(side_effect=RuntimeError("network error"))
        feasibility = _feasibility([
            {
                "keyword": "home care",
                "evidence": "Provide personal care to residents",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        # Original bullet unchanged
        assert "Provide personal care to residents including bathing and dressing." in result

    def test_llm_returns_empty_keeps_original(self):
        """An empty or too-short LLM response preserves the original bullet."""
        client = _make_client("")  # empty response
        feasibility = _feasibility([
            {
                "keyword": "home care",
                "evidence": "Provide personal care to residents",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        assert "Provide personal care to residents including bathing and dressing." in result

    def test_skills_section_bullets_not_rewritten(self):
        """Bullets inside ## Skills are never targeted for rewriting."""
        client = _make_client("Rewritten incorrectly.")
        # Use evidence that strongly matches a Skills line
        feasibility = _feasibility([
            {
                "keyword": "home care",
                "evidence": "dementia care teamwork communication",
            }
        ])
        result = asyncio.get_event_loop().run_until_complete(
            _targeted_bullet_rewrites(client, _BASE_MD, feasibility)
        )
        # Skills section should be unchanged
        assert "- **Care Skills:** Personal Care, Dementia Care" in result
        assert "- **Soft Skills:** Teamwork, Communication" in result
