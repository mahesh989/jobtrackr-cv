"""
Request-ID propagation.

Every incoming request gets an `X-Request-ID` header — either echoed from the
client / load balancer, or freshly minted. The id is:
  - stored in a contextvar so logs from anywhere in the request lifecycle
    (including background tasks started in-request) carry it
  - attached to log records via a filter, so the formatter can print it
  - tagged on Sentry events so error grouping cross-references logs and traces
  - returned in the response header so clients can quote it in bug reports
"""
from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar
from typing import Optional

import sentry_sdk
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

_request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)

REQUEST_ID_HEADER = "x-request-id"


def get_request_id() -> Optional[str]:
    return _request_id_var.get()


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER)
        rid = incoming if incoming else uuid.uuid4().hex
        token = _request_id_var.set(rid)
        sentry_sdk.set_tag("request_id", rid)
        try:
            response = await call_next(request)
        finally:
            _request_id_var.reset(token)
        response.headers[REQUEST_ID_HEADER] = rid
        return response


class RequestIdLogFilter(logging.Filter):
    """Inject the current request id (or '-') into every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id_var.get() or "-"
        return True
