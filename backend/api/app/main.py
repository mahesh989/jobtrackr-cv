"""
CV Magic — FastAPI application entry point.
"""
from __future__ import annotations

import json
import logging
import logging.config
import os
import time
import uuid
from contextvars import ContextVar
from typing import Optional

import sentry_sdk
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.config import get_settings
from app.routes import health, internal

# ---------------------------------------------------------------------------
# Request-ID propagation
#
# Every incoming request gets an `X-Request-ID` header — either echoed from
# the client / load balancer, or freshly minted. The id is:
#   - stored in a contextvar so logs from anywhere in the request lifecycle
#     (including background tasks started in-request) carry it
#   - attached to log records via a filter, so the formatter can print it
#   - tagged on Sentry events so error grouping cross-references logs and traces
#   - returned in the response header so clients can quote it in bug reports
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Settings + Logging
# ---------------------------------------------------------------------------

settings = get_settings()


class JsonFormatter(logging.Formatter):
    """Tiny JSON formatter — avoids adding a logging dependency."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # Surface any structured `extra={...}` keys
        for k, v in record.__dict__.items():
            if k in payload or k.startswith("_"):
                continue
            if k in ("args", "msg", "levelname", "levelno", "pathname", "filename",
                     "module", "exc_info", "exc_text", "stack_info", "lineno",
                     "funcName", "created", "msecs", "relativeCreated", "thread",
                     "threadName", "processName", "process", "name", "asctime",
                     "request_id"):
                continue
            try:
                json.dumps(v)
                payload[k] = v
            except (TypeError, ValueError):
                payload[k] = repr(v)
        return json.dumps(payload, default=str)


def _configure_logging() -> None:
    root = logging.getLogger()
    # Clear handlers added by uvicorn / basicConfig before us
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler()
    if settings.is_production:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s [%(request_id)s] %(name)s — %(message)s"
            )
        )
    handler.addFilter(RequestIdLogFilter())
    root.addHandler(handler)
    root.setLevel(getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))


_configure_logging()
logger = logging.getLogger(__name__)

# Announce the active tailored-CV writer at boot so the Fly logs make the
# W1(legacy) vs W3(w8_verified) selection unambiguous — the difference between
# named-employer summaries (W3) and anchorless ones (W1).
logger.info("tailored-CV writer (boot): %s", settings.TAILORED_CV_WRITER)

# ---------------------------------------------------------------------------
# Sentry (no-op when DSN is not set)
# ---------------------------------------------------------------------------

if settings.SENTRY_DSN:
    # Prefer explicit RELEASE; on Render, RENDER_GIT_COMMIT is auto-injected;
    # on Vercel/Railway/Fly, fall through to None (Sentry will infer or skip).
    release = os.getenv("RELEASE") or os.getenv("RENDER_GIT_COMMIT") or None
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        traces_sample_rate=0.1 if settings.is_production else 0.0,
        environment=settings.ENVIRONMENT,
        release=release,
        send_default_pii=False,
    )

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="JobTrackr CV Pipeline",
    version="0.1.0",
    docs_url="/docs" if settings.ENVIRONMENT != "production" else None,
    redoc_url="/redoc" if settings.ENVIRONMENT != "production" else None,
)

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

# This service is internal (HMAC-signed, server-to-server only) — the browser
# never calls it directly, so CORS is mostly moot. We still pin methods and
# headers to exactly what the endpoints use rather than "*", as defence in depth.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Signature", "X-Timestamp", "X-Request-ID"],
    expose_headers=["x-request-id"],
)

# Request-ID propagation must wrap everything
app.add_middleware(RequestIdMiddleware)


# ---------------------------------------------------------------------------
# Access log
# ---------------------------------------------------------------------------


@app.middleware("http")
async def access_log(request: Request, call_next):
    """Log one structured line per request with method, path, status, latency."""
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
        logger.exception(
            "request error",
            extra={
                "method": request.method,
                "path": request.url.path,
                "elapsed_ms": elapsed_ms,
            },
        )
        raise
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    logger.info(
        "request",
        extra={
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "elapsed_ms": elapsed_ms,
        },
    )
    return response


# ---------------------------------------------------------------------------
# Global exception handler
# ---------------------------------------------------------------------------


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": "Internal server error",
            "request_id": get_request_id(),
        },
    )


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

app.include_router(health.router)
app.include_router(internal.router)
