"""C24 / finding #3 — the Anthropic max_tokens retry re-sends `temperature`
after the model just rejected it.

`_anthropic_complete` handles "this model rejects `temperature`" by catching
the 400 and re-calling `_call(max_tokens, include_temperature=False)` — but
never records that fact anywhere. The very next block retries truncation
with `_call(max_tokens * 2)`, using the default `include_temperature=True`,
sending temperature straight back to the model that just refused it. That
call sits outside the inner try, so the 400 escapes as a fatal AIClientError
instead of the retry succeeding — for any long CV (which is exactly when the
truncation retry fires) on a temperature-rejecting model (Opus 4.7+).

The OpenAI path does not have this bug: its strip-and-retry lives inside
_do_call, so the doubled-token retry re-invokes _do_call and re-detects the
rejection fresh each time. Anthropic's path pulled the check out to the
caller and lost that protection.
"""
from __future__ import annotations

import asyncio

from app.services.ai.client import AIClient


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


_TEMP_REJECTED_MSG = (
    "This model does not support the `temperature` parameter; "
    "it is deprecated for this model."
)


class _FakeBlock:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text


class _FakeResponse:
    def __init__(self, stop_reason: str, text: str = "ok"):
        self.stop_reason = stop_reason
        self.usage = None
        self.content = [_FakeBlock(text)]


class _RejectsTemperatureThenTruncatesOnce:
    """Simulates a model that:
      - rejects `temperature` on EVERY call it appears in (not just the first)
      - truncates (stop_reason=max_tokens) on its first temperature-free call

    Records every call's kwargs so the test can assert on exactly what the
    doubled-token retry sent.
    """

    def __init__(self):
        self.calls: list[dict] = []
        self._temp_free_successes = 0

    async def __call__(self, **kwargs):
        self.calls.append(dict(kwargs))
        if "temperature" in kwargs:
            raise Exception(_TEMP_REJECTED_MSG)
        self._temp_free_successes += 1
        if self._temp_free_successes == 1:
            return _FakeResponse(stop_reason="max_tokens", text="truncated")
        return _FakeResponse(stop_reason="end_turn", text="final answer")


class _AcceptsTemperatureAlwaysTruncatesOnce:
    """Control: a model that never rejects temperature at all, but still
    truncates once. Guards against an overcorrected fix that unconditionally
    strips temperature on the truncation retry even when it was never
    rejected in the first place."""

    def __init__(self):
        self.calls: list[dict] = []
        self._calls_made = 0

    async def __call__(self, **kwargs):
        self.calls.append(dict(kwargs))
        self._calls_made += 1
        if self._calls_made == 1:
            return _FakeResponse(stop_reason="max_tokens", text="truncated")
        return _FakeResponse(stop_reason="end_turn", text="final answer")


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
    return AIClient(provider="anthropic", model="claude-opus-test", api_key="sk-test")


class TestMaxTokensRetryHonoursStrippedTemperature:
    def test_truncation_retry_reuses_the_stripped_temperature_flag(self, monkeypatch):
        """The exact bug: model rejects temperature, then truncates. Before
        the fix, the doubled-token retry re-sent temperature and the whole
        call died with AIClientError even though the model would have
        happily completed it without temperature."""
        fake = _RejectsTemperatureThenTruncatesOnce()
        monkeypatch.setattr(
            "anthropic.AsyncAnthropic", _fake_async_anthropic_factory(fake)
        )
        result = _run(
            _client().complete(
                system="sys", user="usr", max_tokens=100, temperature=0.1,
            )
        )
        assert result == "final answer"
        assert len(fake.calls) == 3
        # Call 1: initial attempt, WITH temperature (rejected).
        assert "temperature" in fake.calls[0]
        # Call 2: retry without temperature (accepted, but truncated).
        assert "temperature" not in fake.calls[1]
        # Call 3: the max_tokens*2 truncation retry — must NOT re-send
        # temperature, since we already learned this model rejects it.
        assert "temperature" not in fake.calls[2]
        assert fake.calls[2]["max_tokens"] == 200

    def test_truncation_retry_still_sends_temperature_when_never_rejected(
        self, monkeypatch
    ):
        """Control: when the model never rejected temperature in the first
        place, the truncation retry must still send it — the fix must track
        what was actually learned, not unconditionally strip."""
        fake = _AcceptsTemperatureAlwaysTruncatesOnce()
        monkeypatch.setattr(
            "anthropic.AsyncAnthropic", _fake_async_anthropic_factory(fake)
        )
        result = _run(
            _client().complete(
                system="sys", user="usr", max_tokens=100, temperature=0.1,
            )
        )
        assert result == "final answer"
        assert len(fake.calls) == 2
        assert "temperature" in fake.calls[0]
        assert "temperature" in fake.calls[1]
        assert fake.calls[1]["max_tokens"] == 200
