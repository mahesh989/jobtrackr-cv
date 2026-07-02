"""Pipeline concurrency cap — regression for the bulk ConnectionTerminated bug.

/internal/analyze fires every request as an unbounded FastAPI BackgroundTask, so
a bulk auto-analysis (select N jobs → N instant 202s) used to spin up N pipelines
at once. That stampede hammered the shared Supabase client's HTTP/2 connection
into a GOAWAY (surfacing as <ConnectionTerminated …>), blew past the user's
AI-key rate limit, and risked OOM from concurrent ReportLab renders. Manual
single runs never tripped it (1 pipeline = a handful of streams).

run_analysis_pipeline now gates the real work behind _PIPELINE_SEMAPHORE. These
tests prove the gate bounds concurrency and that the inner pipeline still runs
for every request (nothing is dropped — excess runs queue, they don't fail).
"""
from __future__ import annotations

import asyncio

import app.services.pipeline.orchestrator as orch


def _run(coro):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_closed():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def test_bulk_stampede_bounded_to_cap(monkeypatch):
    """20 simultaneous requests must never exceed the cap in flight at once."""
    CAP = 4

    async def scenario():
        # Fresh semaphore bound to THIS loop (avoids cross-test loop binding).
        monkeypatch.setattr(orch, "_PIPELINE_SEMAPHORE", asyncio.Semaphore(CAP))

        state = {"active": 0, "peak": 0, "ran": 0}

        async def fake_inner(_payload):
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            await asyncio.sleep(0.02)  # simulate pipeline work
            state["active"] -= 1
            state["ran"] += 1

        monkeypatch.setattr(orch, "_run_analysis_pipeline_inner", fake_inner)

        await asyncio.gather(*[orch.run_analysis_pipeline(object()) for _ in range(20)])
        return state

    state = _run(scenario())
    assert state["peak"] == CAP, f"peak concurrency {state['peak']} exceeded cap {CAP}"
    assert state["ran"] == 20, "every queued run must still execute — none dropped"


def test_single_run_is_not_blocked(monkeypatch):
    """A lone manual analysis always finds a free slot — the cap never delays it."""

    async def scenario():
        monkeypatch.setattr(orch, "_PIPELINE_SEMAPHORE", asyncio.Semaphore(4))
        ran = {"count": 0}

        async def fake_inner(_payload):
            ran["count"] += 1

        monkeypatch.setattr(orch, "_run_analysis_pipeline_inner", fake_inner)
        await orch.run_analysis_pipeline(object())
        return ran["count"]

    assert _run(scenario()) == 1


def test_slot_released_even_when_inner_raises(monkeypatch):
    """If the inner ever raised, the slot must still free (async with releases on
    exception) — otherwise a few failures would permanently shrink the pool."""

    async def scenario():
        monkeypatch.setattr(orch, "_PIPELINE_SEMAPHORE", asyncio.Semaphore(1))

        async def boom(_payload):
            raise RuntimeError("inner blew up")

        monkeypatch.setattr(orch, "_run_analysis_pipeline_inner", boom)

        # First call raises through the wrapper (wrapper doesn't swallow — the
        # real inner never raises, but if it did the slot must still release).
        for _ in range(3):
            try:
                await orch.run_analysis_pipeline(object())
            except RuntimeError:
                pass
        # If the slot leaked, the semaphore would be at 0 and this would hang.
        return orch._PIPELINE_SEMAPHORE._value

    assert _run(scenario()) == 1, "semaphore slot leaked after inner raised"


def test_default_cap_matches_settings():
    """The module semaphore is sized from MAX_CONCURRENT_ANALYSES (default 4)."""
    from app.config import get_settings

    assert orch._PIPELINE_SEMAPHORE._value == max(1, get_settings().MAX_CONCURRENT_ANALYSES)
