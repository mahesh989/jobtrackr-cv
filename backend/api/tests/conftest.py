"""Test bootstrap: provide dummy Supabase/DB env so importing app modules
(which build a pydantic Settings at import time) doesn't require real secrets."""
import asyncio
import os

import pytest

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_ANON_KEY", "test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

# A dummy HMAC secret so verify_hmac exercises its real path (missing headers →
# 401) instead of the "secret not set → 500" guard, which the route-surface
# test relies on.
os.environ.setdefault("JOBTRACKR_HMAC_SECRET", "test-secret")


@pytest.fixture(autouse=True)
def _ensure_current_event_loop_after_each_test():
    """C41e: a handful of test files (test_writer_w8_upload_threading.py,
    test_targeted_bullet_rewrites.py, test_summary_anchor_retry.py, and
    others — grep `asyncio.get_event_loop()` in tests/) use a plain
    `_await(coro) = asyncio.get_event_loop().run_until_complete(coro)`
    helper, relying on the deprecated implicit-current-loop fallback.

    pytest-asyncio's own per-test teardown calls `asyncio.set_event_loop(None)`
    after every `@pytest.mark.asyncio` test. That disables the implicit
    fallback's auto-create behaviour (it only fires when
    `set_event_loop` was never explicitly called), so `get_event_loop()`
    raises "There is no current event loop in thread 'MainThread'"
    instead of transparently creating one — breaking every subsequent
    `_await()`-style test in the SAME session, regardless of which file
    it's in, purely because of pytest's collection order.

    Rather than migrating every `_await()`-style helper (higher-risk —
    one of them explicitly documents trying `asyncio.run()` and
    rejecting it: "NOT asyncio.run(), which closes/unsets the global
    loop"), this autouse fixture runs after EVERY test and guarantees a
    valid, open current loop always exists for whatever runs next —
    closing the actual gap (an unusable "current loop" slot) rather than
    changing either style's test code.
    """
    yield
    try:
        loop = asyncio.get_event_loop_policy().get_event_loop()
        loop_needs_replacing = loop.is_closed()
    except RuntimeError:
        loop_needs_replacing = True
    if loop_needs_replacing:
        asyncio.set_event_loop(asyncio.new_event_loop())
