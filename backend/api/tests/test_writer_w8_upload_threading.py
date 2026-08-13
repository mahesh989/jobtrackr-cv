"""
Regression test for #12 (audit, execution chunk C50): run_tailored_cv_w8_
verified() — the actual DEFAULT production writer (config.py's
TAILORED_CV_WRITER default) — called the blocking Supabase Storage upload
(_upload_to_storage, a real network call) directly on the event loop,
sitting one line above a sibling call (_persist_quality_flags) that was
already correctly wrapped in asyncio.to_thread. This is the exact call
chain the audit cited ("_impl.py:847 → tailored_cv/runner.py:98") — the
companion fix in runner.py's own run_tailored_cv (the "legacy" writer
path, config.py's TAILORED_CV_WRITER=legacy fallback) does not cover this
call site, since _impl.py imports and calls _upload_to_storage directly
rather than going through run_tailored_cv.

Same measurement technique as test_tailored_cv_runner_upload_threading.py:
run a slow (simulated) upload concurrently with an independent heartbeat
coroutine via asyncio.gather and compare total wall-clock time. A
properly-threaded upload overlaps with the heartbeat; a blocked event loop
serialises them.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.services.eval.writers import _impl

VALID_MD = "## Career Highlights\n" + ("Experienced professional. " * 10) + "\n\n## Experience\n- Did things.\n"

SLOW_UPLOAD_S = 0.2
HEARTBEAT_TOTAL_S = 0.15
HEARTBEAT_INTERVAL_S = 0.01


def _await(coro):
    # Matches this suite's established convention (test_summary_anchor_retry.py) —
    # NOT asyncio.run(), which closes/unsets the global loop.
    return asyncio.get_event_loop().run_until_complete(coro)


def _total_wall_time(monkeypatch, slow: bool) -> float:
    def upload(user_id, run_id, markdown):
        if slow:
            time.sleep(SLOW_UPLOAD_S)  # simulates a real blocking network upload
        return f"{user_id}/{run_id}.md"

    monkeypatch.setattr(_impl, "_upload_to_storage", upload)
    monkeypatch.setattr(
        _impl, "_writer_w8_verified",
        AsyncMock(return_value=SimpleNamespace(tailored_md=VALID_MD)),
    )
    monkeypatch.setattr(_impl, "_persist_quality_flags", lambda *a, **kw: None)

    async def heartbeat():
        n_ticks = int(HEARTBEAT_TOTAL_S / HEARTBEAT_INTERVAL_S)
        for _ in range(n_ticks):
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)

    async def run_both():
        await asyncio.gather(
            _impl.run_tailored_cv_w8_verified(
                client=object(),
                user_id=uuid.uuid4(),
                run_id=uuid.uuid4(),
                cv_text="some cv text",
                jd_text="some jd text",
                jd_analysis={},
                matching={},
                ats={},
                input_recs={},
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
    threshold = (SLOW_UPLOAD_S + HEARTBEAT_TOTAL_S) * 0.75
    assert total < threshold, (
        f"upload and heartbeat ran serially (total={total:.3f}s >= {threshold:.3f}s) "
        "— the event loop was blocked during the upload"
    )


def test_fast_upload_baseline_is_well_under_the_serial_sum(monkeypatch):
    """Sanity check the harness itself."""
    total = _total_wall_time(monkeypatch, slow=False)
    assert total < HEARTBEAT_TOTAL_S * 1.5
