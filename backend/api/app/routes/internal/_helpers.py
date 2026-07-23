"""Shared helpers for the internal (HMAC-signed) routes."""
from __future__ import annotations

from fastapi import HTTPException, status

from app.services.ai.client import AIClient, AIClientError, make_ai_client


def build_ai_client_or_422(body, *, detail_prefix: str = "") -> AIClient:
    """Construct the BYOK AI client from a request carrying ai_provider /
    ai_api_key / ai_model, mapping AIClientError → HTTP 422.

    detail_prefix preserves each route's historical error-detail format:
    "" → detail=str(exc); "Invalid AI client configuration: " → the prefixed
    form. Response bodies are byte-identical to the pre-refactor handlers.
    """
    try:
        return make_ai_client(body.ai_provider, body.ai_api_key, body.ai_model)
    except AIClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{detail_prefix}{exc}" if detail_prefix else str(exc),
        ) from exc
