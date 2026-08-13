"""
Regression tests for #6/#7 (audit, execution chunk C47): progress.py's
terminal-status and step-result writers silently swallowed a persistent
Supabase write failure — supabase_update() logged a warning and returned
normally after exhausting its retries, so mark_run_completed / save_step_
result then logged a SUCCESS message regardless. A Supabase blip on the
terminal write stranded analysis_runs.status='running' forever (a live
Realtime spinner with no error), and a step-result write failure could
leave a run marked "completed" with that column still NULL, with no error
surfaced anywhere.

Fix: supabase_update() now returns a bool (success/failure). The writers
that matter for this (mark_run_running, mark_run_completed,
save_step_result) now RAISE when the write fails, instead of continuing —
the orchestrator's existing catch-all already exists to route any internal
error into mark_run_failed, so a persistent DB blip now produces an honest
"failed" run instead of one stuck at "running" forever. mark_run_failed
itself is the pipeline's own last-resort error handler and must never
raise further, so it stays best-effort but logs its own failure honestly
instead of claiming "→ failed" when its write didn't actually land.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from unittest.mock import AsyncMock

import pytest

from app.services.pipeline import progress

RUN_ID = uuid.uuid4()


def _await(coro):
    # Reuse the shared loop (matches the other async tests in this suite).
    # NOT asyncio.run() — that closes/unsets the global loop and breaks
    # tests that rely on asyncio.get_event_loop().run_until_complete().
    return asyncio.get_event_loop().run_until_complete(coro)


def test_REGRESSION_mark_run_completed_raises_instead_of_lying_when_write_fails(monkeypatch):
    monkeypatch.setattr(progress, "supabase_update", AsyncMock(return_value=False))
    with pytest.raises(RuntimeError, match="mark_run_completed"):
        _await(progress.mark_run_completed(RUN_ID))


def test_mark_run_completed_succeeds_silently_when_write_succeeds(monkeypatch):
    mock = AsyncMock(return_value=True)
    monkeypatch.setattr(progress, "supabase_update", mock)
    _await(progress.mark_run_completed(RUN_ID))
    mock.assert_awaited_once()
    args, _ = mock.await_args
    assert args[0] == "analysis_runs"
    assert args[1] == RUN_ID


def test_REGRESSION_mark_run_running_raises_instead_of_lying_when_write_fails(monkeypatch):
    monkeypatch.setattr(progress, "supabase_update", AsyncMock(return_value=False))
    with pytest.raises(RuntimeError, match="mark_run_running"):
        _await(progress.mark_run_running(RUN_ID))


def test_REGRESSION_save_step_result_raises_instead_of_silently_continuing_when_write_fails(monkeypatch):
    monkeypatch.setattr(progress, "supabase_update", AsyncMock(return_value=False))
    with pytest.raises(RuntimeError, match="jd_analysis_result"):
        _await(progress.save_step_result(RUN_ID, "jd_analysis_result", {"job_title": "Nurse"}))


def test_save_step_result_succeeds_silently_when_write_succeeds(monkeypatch):
    mock = AsyncMock(return_value=True)
    monkeypatch.setattr(progress, "supabase_update", mock)
    _await(progress.save_step_result(RUN_ID, "jd_analysis_result", {"job_title": "Nurse"}))
    mock.assert_awaited_once()


def test_mark_run_failed_does_not_raise_when_its_own_write_fails(monkeypatch, caplog):
    """mark_run_failed is the pipeline's own last-resort error handler — it
    must NEVER raise further (orchestrator.py's catch-all depends on that),
    even when its own write fails."""
    monkeypatch.setattr(progress, "supabase_update", AsyncMock(return_value=False))
    with caplog.at_level(logging.ERROR):
        _await(progress.mark_run_failed(RUN_ID, "boom", dict(progress.DEFAULT_STEP_STATUS)))
    assert "mark_run_failed's own DB write failed" in caplog.text


def test_mark_run_failed_logs_the_honest_outcome_when_its_write_succeeds(monkeypatch, caplog):
    monkeypatch.setattr(progress, "supabase_update", AsyncMock(return_value=True))
    with caplog.at_level(logging.INFO):
        _await(progress.mark_run_failed(RUN_ID, "boom", dict(progress.DEFAULT_STEP_STATUS)))
    assert "own DB write failed" not in caplog.text
    assert any("failed" in rec.message for rec in caplog.records)
