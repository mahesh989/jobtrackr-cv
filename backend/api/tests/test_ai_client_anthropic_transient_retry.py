"""C67: `_anthropic_complete`'s transient-error retry loop and billing-error
short-circuit (client.py:334-640) had no direct test coverage — only the
temperature-rejection/max_tokens-truncation interaction
(test_ai_client_anthropic_temp_retry.py) and the classifier helpers in
isolation (test_ai_client_classifier.py) were covered. These pin the retry
loop itself: a transient failure retries and can succeed, a billing failure
never retries, and exhausting all retries raises the classified error.
"""
from __future__ import annotations

import asyncio

import pytest

from app.services.ai.client import AIBillingError, AIClient, AIClientError, AIRateLimitError


def _run(coro):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_closed():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


class _FakeBlock:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, text: str = "ok"):
        self.stop_reason = "end_turn"
        self.usage = None
        self.content = [_FakeBlock(text)]


def _fake_async_anthropic_factory(create_fn):
    class _FakeMessages:
        def __init__(self):
            self.create = create_fn

    class _FakeAnthropicClient:
        def __init__(self):
            self.messages = _FakeMessages()

    class _FakeAsyncAnthropic:
        def __init__(self, api_key=None):
            pass

        async def __aenter__(self):
            return _FakeAnthropicClient()

        async def __aexit__(self, *exc):
            return False

    return _FakeAsyncAnthropic


def _client() -> AIClient:
    return AIClient(provider="anthropic", model="claude-test", api_key="sk-test")


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    """The retry loop sleeps 1.5s/3s/... between attempts — stub it so this
    test module doesn't add real wall-clock delay to the suite."""
    async def _instant_sleep(_seconds):
        return None

    monkeypatch.setattr("app.services.ai.client._asyncio_mod.sleep", _instant_sleep)


def test_transient_connection_error_retries_then_succeeds(monkeypatch):
    calls: list[int] = []

    async def create(**kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise Exception("Connection reset by peer")
        return _FakeResponse(text="recovered")

    monkeypatch.setattr("anthropic.AsyncAnthropic", _fake_async_anthropic_factory(create))
    result = _run(_client().complete(system="s", user="u", max_tokens=100, temperature=0.1))
    assert result == "recovered"
    assert len(calls) == 2


def test_rate_limit_error_retries_then_succeeds(monkeypatch):
    calls: list[int] = []

    async def create(**kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise Exception("Error code: 429 - rate limit exceeded")
        return _FakeResponse(text="recovered")

    monkeypatch.setattr("anthropic.AsyncAnthropic", _fake_async_anthropic_factory(create))
    result = _run(_client().complete(system="s", user="u", max_tokens=100, temperature=0.1))
    assert result == "recovered"
    assert len(calls) == 2


def test_transient_error_exhausts_retries_and_raises(monkeypatch):
    """A "connection reset" is transient (retried) but never succeeds here —
    _MAX_RETRIES=2 means 3 total attempts before giving up. The message
    carries no billing/429 marker, so _classify_provider_error's fallback
    wraps it as a plain AIClientError (not the rate-limit/billing subclasses)."""
    calls: list[int] = []

    async def create(**kwargs):
        calls.append(1)
        raise Exception("Connection reset by peer")

    monkeypatch.setattr("anthropic.AsyncAnthropic", _fake_async_anthropic_factory(create))
    with pytest.raises(AIClientError) as exc_info:
        _run(_client().complete(system="s", user="u", max_tokens=100, temperature=0.1))
    assert not isinstance(exc_info.value, (AIBillingError, AIRateLimitError))
    assert len(calls) == 3


def test_billing_error_raises_immediately_without_retry(monkeypatch):
    calls: list[int] = []

    async def create(**kwargs):
        calls.append(1)
        raise Exception("Your credit balance is too low to access the Claude API")

    monkeypatch.setattr("anthropic.AsyncAnthropic", _fake_async_anthropic_factory(create))
    with pytest.raises(AIBillingError):
        _run(_client().complete(system="s", user="u", max_tokens=100, temperature=0.1))
    assert len(calls) == 1, "a billing error must never be retried — retrying can't make money appear"
