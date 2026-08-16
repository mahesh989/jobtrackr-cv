"""
Regression test for C41e: pytest-asyncio's per-test teardown calls
asyncio.set_event_loop(None), which breaks any subsequent test using the
deprecated asyncio.get_event_loop() implicit-current-loop fallback — this
suite's own established `_await()` convention (test_summary_anchor_retry.py,
test_writer_w8_upload_threading.py, test_targeted_bullet_rewrites.py, and
others). See conftest.py's `_ensure_current_event_loop_after_each_test`
fixture for the fix and full rationale.

Self-contained within one file (relying on pytest's default top-to-bottom
in-file collection order) so this doesn't depend on which OTHER files
happen to sit next to it alphabetically elsewhere in the suite.
"""
import asyncio

import pytest


@pytest.mark.asyncio
async def test_a_pytest_asyncio_test_runs_first():
    await asyncio.sleep(0)


async def _identity(x):
    return x


def test_get_event_loop_still_works_immediately_after_a_pytest_asyncio_test():
    # Before the C41e fix, this raised "RuntimeError: There is no current
    # event loop in thread 'MainThread'" — the pytest.mark.asyncio test
    # above's own teardown left no valid current loop for this suite's
    # get_event_loop()-based _await() convention to find.
    loop = asyncio.get_event_loop()
    result = loop.run_until_complete(_identity(42))
    assert result == 42
