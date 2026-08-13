"""
Regression test for #12 (audit, execution chunk C50): run_tailored_cv()
called the blocking Supabase Storage upload (_upload_to_storage, a real
network call) directly on the event loop instead of via asyncio.to_thread —
on the DEFAULT w8_verified path, two files away from pdf_output.py, which
wraps the IDENTICAL upload_or_update call in asyncio.to_thread and
documents exactly why: "ReportLab is CPU-bound, so the render+upload runs
in asyncio.to_thread to keep the event loop free." Blocking here stalls
every other concurrent analysis run sharing the same event loop
(orchestrator.py's own _PIPELINE_SEMAPHORE explicitly allows several runs
concurrently), not just the run doing the upload.

This can't be characterized by asserting a return value — the fix changes
WHEN control is yielded to the event loop, not WHAT gets returned. Instead,
run a slow (simulated) upload CONCURRENTLY (asyncio.gather) with an
independent, fixed-duration "heartbeat" coroutine and measure total
wall-clock time. A properly-threaded upload overlaps with the heartbeat
(total ≈ max(upload, heartbeat)); a blocked event loop serialises them
(total ≈ upload + heartbeat), since the heartbeat can only run to
completion once the event loop is free — either entirely before or
entirely after the blocking call, never during it.

Empirically verified against both the buggy and fixed source before
picking this metric: a gap-WITHIN-the-heartbeat measurement does NOT
distinguish the two cases (the heartbeat's own tick cadence stays uniform
either way — it just runs to completion earlier or later relative to the
upload) — only total wall-clock time reliably does.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from unittest.mock import AsyncMock, MagicMock

from app.services.pipeline.steps.tailored_cv import runner as tailored_cv_runner

VALID_MD = "## Career Highlights\n" + ("Experienced professional. " * 10) + "\n\n## Experience\n- Did things.\n"

SLOW_UPLOAD_S = 0.2
HEARTBEAT_TOTAL_S = 0.15
HEARTBEAT_INTERVAL_S = 0.01


def _client(markdown: str) -> MagicMock:
    client = MagicMock()
    client.complete = AsyncMock(return_value=markdown)
    return client


def _await(coro):
    # Matches this suite's established convention (test_summary_anchor_retry.py) —
    # NOT asyncio.run(), which closes/unsets the global loop.
    return asyncio.get_event_loop().run_until_complete(coro)


def _total_wall_time(monkeypatch, slow: bool) -> float:
    def upload(user_id, run_id, markdown):
        if slow:
            time.sleep(SLOW_UPLOAD_S)  # simulates a real blocking network upload
        return f"{user_id}/{run_id}.md"

    monkeypatch.setattr(tailored_cv_runner, "_upload_to_storage", upload)

    async def heartbeat():
        n_ticks = int(HEARTBEAT_TOTAL_S / HEARTBEAT_INTERVAL_S)
        for _ in range(n_ticks):
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)

    async def run_both():
        await asyncio.gather(
            tailored_cv_runner.run_tailored_cv(
                client=_client(VALID_MD),
                user_id=uuid.uuid4(),
                run_id=uuid.uuid4(),
                cv_text="some cv text",
                jd_analysis={},
                ai_recommendations_md="",
                feasibility={},
                contact_details=None,
            ),
            heartbeat(),
        )

    start = time.monotonic()
    _await(run_both())
    return time.monotonic() - start


def test_REGRESSION_slow_upload_overlaps_with_a_concurrent_coroutine_instead_of_serialising(monkeypatch):
    total = _total_wall_time(monkeypatch, slow=True)
    # Properly threaded: total ≈ max(upload, heartbeat) ≈ 0.2s.
    # Blocked event loop: total ≈ upload + heartbeat ≈ 0.35s.
    # Threshold sits well below the serial sum and above the concurrent max.
    threshold = (SLOW_UPLOAD_S + HEARTBEAT_TOTAL_S) * 0.75
    assert total < threshold, (
        f"upload and heartbeat ran serially (total={total:.3f}s >= {threshold:.3f}s) "
        "— the event loop was blocked during the upload"
    )


def test_fast_upload_baseline_is_well_under_the_serial_sum(monkeypatch):
    """Sanity check the harness itself."""
    total = _total_wall_time(monkeypatch, slow=False)
    assert total < HEARTBEAT_TOTAL_S * 1.5
