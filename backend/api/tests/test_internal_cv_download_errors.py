"""
Regression tests for #8 (audit): every /internal/extract-cv-text download
failure was caught by a blanket `except Exception` and reported as 404 with
the raw exception text echoed into the response — a transient Supabase 5xx
or a network timeout told the caller the file does not exist, and leaked
backend implementation details into a response string.

Reproduced directly (asyncio, no HTTP layer — this route requires HMAC
signing, irrelevant to this specific bug) before writing the fix: a 500
StorageApiError, a raw TimeoutError, and a genuine 404 StorageApiError all
produced the identical `404 "Could not fetch CV file: <raw exc>"` shape.

Fix: StorageApiError.status is inspected — only a genuine 404 from Storage
is reported as 404 (with a clean message, no raw exception text); every
other case (other StorageApiError statuses, or a raw exception that never
reached Storage at all, e.g. a timeout) is a 502 with a generic message —
matching what actually happened (storage was unreachable/erroring), and
full detail still goes to the server log, never the response.
"""
import asyncio
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from storage3.exceptions import StorageApiError

from app.routes.internal.cv import extract_cv_text
from app.schemas.internal import ExtractCvTextRequest

BODY = ExtractCvTextRequest(storage_path="cvs/u1/cv1.pdf")


def _await(coro):
    # NOT asyncio.run() — matches this suite's convention (see
    # test_summary_anchor_retry.py) of reusing the shared event loop rather
    # than closing/unsetting it between tests. Falls back to creating one
    # when run after another test in the full suite has already closed the
    # thread's "current" loop (get_event_loop() then raises RuntimeError in
    # Python 3.12) — reproduced directly: this file's tests passed in
    # isolation but failed with exactly that RuntimeError as part of the
    # full suite, order-dependent on what ran before them.
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _mock_download_raises(exc: Exception) -> MagicMock:
    mock_supabase = MagicMock()
    mock_supabase.storage.from_.return_value.download.side_effect = exc
    return mock_supabase


def test_REGRESSION_a_transient_500_from_storage_is_502_not_404():
    with patch("app.routes.internal.cv.get_supabase") as mock_sb:
        mock_sb.return_value = _mock_download_raises(
            StorageApiError("Internal Server Error", "InternalError", 500)
        )
        with pytest.raises(HTTPException) as exc_info:
            _await(extract_cv_text(BODY))

    assert exc_info.value.status_code == 502
    # The raw exception text must NOT be echoed into the response.
    assert "InternalError" not in exc_info.value.detail
    assert "Internal Server Error" not in exc_info.value.detail


def test_REGRESSION_a_raw_network_timeout_is_502_not_404():
    with patch("app.routes.internal.cv.get_supabase") as mock_sb:
        mock_sb.return_value = _mock_download_raises(TimeoutError("connection timed out after 30s"))
        with pytest.raises(HTTPException) as exc_info:
            _await(extract_cv_text(BODY))

    assert exc_info.value.status_code == 502
    assert "timed out" not in exc_info.value.detail


def test_a_genuine_404_from_storage_still_reports_404_with_a_clean_message():
    with patch("app.routes.internal.cv.get_supabase") as mock_sb:
        mock_sb.return_value = _mock_download_raises(
            StorageApiError("Object not found", "not_found", 404)
        )
        with pytest.raises(HTTPException) as exc_info:
            _await(extract_cv_text(BODY))

    assert exc_info.value.status_code == 404
    assert "not_found" not in exc_info.value.detail  # still no raw exception text
    assert "Object not found" not in exc_info.value.detail
