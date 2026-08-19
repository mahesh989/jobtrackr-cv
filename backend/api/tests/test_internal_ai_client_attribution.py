"""C67: build_ai_client_or_422 constructed every internal route's AIClient
via make_ai_client(), which never sets operation/user_id (by design — it
only builds from request-carried BYOK values). No route call site passed
them either, so every internal-route AI call was attributed to
AIClient's bare defaults (operation="unknown", user_id=None) in the
ai_calls telemetry table, regardless of which route/user actually made
the call. Fixed by having the helper accept and set both.
"""
from __future__ import annotations

import pytest

from app.enums import Provider
from app.routes.internal._helpers import build_ai_client_or_422
from app.services.ai.client import AIClientError


class _Body:
    def __init__(self, ai_provider=Provider.ANTHROPIC, ai_api_key="sk-test", ai_model=None):
        self.ai_provider = ai_provider
        self.ai_api_key = ai_api_key
        self.ai_model = ai_model


def test_operation_defaults_to_unknown_when_not_passed():
    client = build_ai_client_or_422(_Body())
    assert client.operation == "unknown"


def test_operation_is_set_when_passed():
    client = build_ai_client_or_422(_Body(), operation="structurize_cv")
    assert client.operation == "structurize_cv"


def test_user_id_defaults_to_none_when_not_passed():
    client = build_ai_client_or_422(_Body())
    assert client.user_id is None


def test_user_id_is_set_and_stringified_when_passed():
    client = build_ai_client_or_422(_Body(), user_id="11111111-1111-1111-1111-111111111111")
    assert client.user_id == "11111111-1111-1111-1111-111111111111"


def test_still_raises_422_on_bad_api_key():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        build_ai_client_or_422(_Body(ai_api_key=""), operation="structurize_cv")
    assert exc_info.value.status_code == 422
