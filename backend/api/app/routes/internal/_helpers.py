"""Shared helpers for the internal (HMAC-signed) routes."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, status

from app.services.ai.client import AIClient, AIClientError, make_ai_client


def build_ai_client_or_422(
    body,
    *,
    detail_prefix: str = "",
    operation: Optional[str] = None,
    user_id: Optional[Any] = None,
) -> AIClient:
    """Construct the BYOK AI client from a request carrying ai_provider /
    ai_api_key / ai_model, mapping AIClientError → HTTP 422.

    detail_prefix preserves each route's historical error-detail format:
    "" → detail=str(exc); "Invalid AI client configuration: " → the prefixed
    form. Response bodies are byte-identical to the pre-refactor handlers.

    operation/user_id (C67) — attribution for the ai_calls telemetry table.
    Every call site previously left both at AIClient's bare defaults
    (operation="unknown", user_id=None), since make_ai_client() itself never
    sets them (by design — it only builds from request-carried BYOK values).
    Pass a per-route operation label always; pass user_id only when the
    request schema actually carries one (most BYOK schemas here don't —
    adding it is a cross-service schema + caller change, out of scope here).
    """
    try:
        client = make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{detail_prefix}{exc}" if detail_prefix else str(exc),
        ) from exc
    if operation is not None:
        client.operation = operation
    if user_id is not None:
        client.user_id = str(user_id)
    return client
