"""
Regression tests for #15 (audit): the request-id contextvar was invisible
to both the access log and the global 500 handler — every access-log line
carried request_id "-", every 500 body carried request_id: null.

Root cause: RequestIdMiddleware was a BaseHTTPMiddleware/dispatch()-based
middleware. BaseHTTPMiddleware's call_next() spawns the downstream app in a
separate anyio task via task_group.start_soon(), and that spawn happens
BEFORE dispatch() (the code that calls _request_id_var.set()) ever runs —
so the set was captured too late for the downstream task (access_log, the
route, the exception handler) to see it. Confirmed directly against a
minimal reproduction before writing the fix. Converting RequestIdMiddleware
to plain ASGI middleware, wrapped around the exported `app` object itself
(not registered via add_middleware()), closes it — verified here against
the REAL exported app and REAL access_log/exception-handler code, not a
synthetic minimal app.
"""
import logging

from fastapi.testclient import TestClient

from app.main import app, fastapi_app, get_request_id, RequestIdLogFilter


def _capture_logs():
    stream_records = []

    class ListHandler(logging.Handler):
        def emit(self, record):
            stream_records.append(record)

    handler = ListHandler()
    handler.addFilter(RequestIdLogFilter())
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    return stream_records, handler


def test_response_header_carries_the_request_id():
    client = TestClient(app)
    resp = client.get("/health", headers={"X-Request-ID": "test-rid-header-1"})
    assert resp.status_code == 200
    assert resp.headers.get("x-request-id") == "test-rid-header-1"


def test_REGRESSION_access_log_sees_the_request_id_not_a_dash():
    records, handler = _capture_logs()
    try:
        client = TestClient(app)
        client.get("/health", headers={"X-Request-ID": "test-rid-access-log"})
    finally:
        logging.getLogger().removeHandler(handler)

    request_lines = [r for r in records if r.name == "app.main" and r.getMessage() == "request"]
    assert request_lines, "expected an access-log 'request' line to have been emitted"
    assert request_lines[-1].request_id == "test-rid-access-log"


def test_REGRESSION_the_500_handler_sees_the_request_id_not_null():
    @fastapi_app.get("/__test_boom_c65")
    async def _boom():
        raise RuntimeError("deliberate test failure")

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/__test_boom_c65", headers={"X-Request-ID": "test-rid-500-handler"})

    assert resp.status_code == 500
    assert resp.json()["request_id"] == "test-rid-500-handler"


def test_REGRESSION_the_500_handlers_own_log_line_sees_the_request_id():
    @fastapi_app.get("/__test_boom_c65_log")
    async def _boom():
        raise RuntimeError("deliberate test failure")

    records, handler = _capture_logs()
    try:
        client = TestClient(app, raise_server_exceptions=False)
        client.get("/__test_boom_c65_log", headers={"X-Request-ID": "test-rid-500-log"})
    finally:
        logging.getLogger().removeHandler(handler)

    exc_lines = [r for r in records if "Unhandled exception" in r.getMessage()]
    assert exc_lines, "expected the exception handler's log line to have been emitted"
    assert exc_lines[-1].request_id == "test-rid-500-log"


def test_a_request_with_no_incoming_header_still_gets_a_minted_id():
    client = TestClient(app)
    resp = client.get("/health")
    rid = resp.headers.get("x-request-id")
    assert rid  # minted, non-empty
    assert len(rid) == 32  # uuid4().hex
