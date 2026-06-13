"""
HMAC-SHA256 request verification for internal JobTrackr → cv-backend calls.

cv-backend has no public auth surface. The only allowed caller is JobTrackr's
Next.js API routes. Each request must carry:

  X-Timestamp: <unix-seconds>
  X-Signature: hex-encoded HMAC-SHA256( secret, timestamp + body )

Where `secret` is the shared JOBTRACKR_HMAC_SECRET env var on both sides.

Verification rejects:
  - Missing headers
  - Timestamp older than MAX_AGE_SECONDS (replay window)
  - Mismatched signature (constant-time compare)

Use as a FastAPI dependency on each /internal/* route:

    from app.security.hmac import verify_hmac
    @router.post("/internal/analyze", dependencies=[Depends(verify_hmac)])
    async def analyze(...): ...
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time

from fastapi import HTTPException, Request, status

from app.config import get_settings

logger = logging.getLogger(__name__)

# Maximum age of a request before we treat it as a replay attempt.
# 5 minutes covers any reasonable clock skew between Vercel and Fly.io.
MAX_AGE_SECONDS = 300


async def verify_hmac(request: Request) -> None:
    """FastAPI dependency — raise 401 if the request signature does not verify."""
    settings = get_settings()
    secret = settings.JOBTRACKR_HMAC_SECRET

    if not secret:
        # Misconfigured server. Reject loudly so we don't silently accept anything.
        logger.error("JOBTRACKR_HMAC_SECRET is not set — refusing all requests")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server HMAC secret not configured",
        )

    ts_header = request.headers.get("x-timestamp")
    sig_header = request.headers.get("x-signature")

    if not ts_header or not sig_header:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Timestamp or X-Signature header",
        )

    # Parse + window check
    try:
        ts = int(ts_header)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Timestamp is not a unix-seconds integer",
        )

    now = int(time.time())
    if abs(now - ts) > MAX_AGE_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"X-Timestamp outside allowed window of {MAX_AGE_SECONDS}s",
        )

    # We need the raw body to recompute the HMAC. FastAPI normally consumes
    # the request stream once via Pydantic parsing — calling .body() before
    # the route handler caches it so downstream parsing still works.
    body = await request.body()

    message = f"{ts}".encode() + body
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, sig_header):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="HMAC signature mismatch",
        )
