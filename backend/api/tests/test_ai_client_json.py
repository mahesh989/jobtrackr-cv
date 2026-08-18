"""JSON extraction, tolerant repair, and regenerate-on-failure retry for the
AI client's complete_json path.

These guard the resilience added after a real prod incident: the JD-analysis
step aborted the whole run because one LLM sample emitted malformed JSON (a
missing comma), and a manual re-run happened to produce valid JSON. The client
should now self-heal — repair the common glitches in place, and regenerate when
even repair can't.

Coroutines are driven on the shared event loop (via _run) so the suite needs no
pytest-asyncio config; complete() is stubbed so no provider is contacted. We
deliberately do NOT use asyncio.run here — it closes the global loop, which
breaks sibling test modules that drive coroutines via
asyncio.get_event_loop().run_until_complete(...).
"""
from __future__ import annotations

import asyncio

import pytest

from app.services.ai.client import (
    AIBillingError,
    AIClient,
    AIJSONParseError,
    _extract_json,
    _first_balanced_object,
)


def _run(coro):
    """Run `coro` on the current event loop, creating one only if needed and
    leaving it open + current afterwards (mirrors the rest of the suite's
    get_event_loop() idiom; never closes the shared loop)."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_closed():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


# The exact shape from the prod failure: a well-formed object missing a comma
# between two fields.
PROD_MISSING_COMMA = (
    '{\n'
    '  "job_title": "Care Worker",\n'
    '  "seniority_level": "unknown"\n'   # <-- missing comma here
    '  "summary": "Compassionate support to older clients at home."\n'
    '}'
)


# --------------------------------------------------------------------------
# _first_balanced_object
# --------------------------------------------------------------------------


def test_first_balanced_object_extracts_block_amid_prose():
    text = 'Sure! Here you go:\n{"a": 1, "b": {"c": 2}}\nHope that helps.'
    assert _first_balanced_object(text) == '{"a": 1, "b": {"c": 2}}'


def test_first_balanced_object_ignores_braces_inside_strings():
    text = '{"note": "a } brace in a string", "ok": true}'
    assert _first_balanced_object(text) == text


def test_first_balanced_object_none_when_no_object():
    assert _first_balanced_object("no json at all") is None


def test_first_balanced_object_none_when_unterminated():
    assert _first_balanced_object('{"a": 1, "b":') is None


# --------------------------------------------------------------------------
# _extract_json — strict, fenced, prose-wrapped
# --------------------------------------------------------------------------


def test_extract_json_strict():
    assert _extract_json('{"a": 1, "b": "two"}') == {"a": 1, "b": "two"}


def test_extract_json_strips_code_fences():
    assert _extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_pulls_object_out_of_prose():
    assert _extract_json('Here:\n{"a": 1}\nthanks') == {"a": 1}


# --------------------------------------------------------------------------
# _extract_json — tolerant repair
# --------------------------------------------------------------------------


def test_extract_json_repairs_missing_comma_prod_case():
    out = _extract_json(PROD_MISSING_COMMA)
    assert out["job_title"] == "Care Worker"
    assert out["seniority_level"] == "unknown"
    assert "summary" in out


def test_extract_json_repairs_trailing_comma():
    assert _extract_json('{"a": 1, "b": 2,}') == {"a": 1, "b": 2}


def test_extract_json_repairs_inside_fenced_block():
    assert _extract_json('```json\n{"a": 1 "b": 2}\n```') == {"a": 1, "b": 2}


# --------------------------------------------------------------------------
# _extract_json — failure modes (must raise, never mask)
# --------------------------------------------------------------------------


def test_extract_json_raises_on_pure_prose():
    with pytest.raises(AIJSONParseError):
        _extract_json("Sorry, I can't help with that.")


def test_extract_json_raises_on_empty():
    with pytest.raises(AIJSONParseError):
        _extract_json("")


def test_extract_json_does_not_mask_garbage_as_empty_dict():
    # json_repair coerces this to "" / {}; the guard must reject it rather than
    # silently return a contentless analysis.
    with pytest.raises(AIJSONParseError):
        _extract_json("<<<not json>>>")


def test_extract_json_rejects_a_top_level_list_of_scalars():
    """C67: _extract_json is typed -> Dict[str, Any] and every caller treats
    its return as a dict (e.g. `.get(...)` immediately), but the strict
    json.loads path (whole-string parse) never checked isinstance(parsed,
    dict) before returning — only the tolerant-repair path (step 4) did. A
    well-formed JSON ARRAY of scalars (the LLM wrapping its answer in
    `[...]` instead of `{...}`) parses successfully at step 2 and used to
    be returned as-is, silently violating the dict contract with no
    AIJSONParseError to trigger complete_json's regenerate-on-failure
    retry. (A list containing an embedded `{...}` object is deliberately
    NOT covered here — step 3's brace-extraction recovering that object is
    the SAME intended graceful-degradation the object-in-prose case gets,
    not a bug.)"""
    with pytest.raises(AIJSONParseError):
        _extract_json('["Nurse", "Aged Care", "Sydney"]')


def test_extract_json_rejects_a_bare_json_scalar():
    """Same contract violation, simpler case: a bare JSON string/number
    still parses successfully under plain json.loads but is not a dict."""
    with pytest.raises(AIJSONParseError):
        _extract_json('"just a string"')


# --------------------------------------------------------------------------
# complete_json — regenerate-on-failure retry
# --------------------------------------------------------------------------


def _client_returning(*outputs):
    """An AIClient whose complete() yields `outputs` in order (last value
    repeats), recording the kwargs of each call. Exceptions in `outputs` are
    raised. No provider is contacted."""
    client = AIClient(provider="anthropic", model="claude-test", api_key="sk-test")
    calls: list[dict] = []

    async def fake_complete(*, system, user, max_tokens, temperature, no_training, operation=None):
        calls.append({"temperature": temperature, "max_tokens": max_tokens, "operation": operation})
        out = outputs[min(len(calls) - 1, len(outputs) - 1)]
        if isinstance(out, Exception):
            raise out
        return out

    client.complete = fake_complete  # type: ignore[method-assign]
    return client, calls


def test_complete_json_repairs_without_regenerating():
    client, calls = _client_returning('{"a": 1 "b": 2}')  # repairable in place
    result = _run(client.complete_json(system="s", user="u"))
    assert result == {"a": 1, "b": 2}
    assert len(calls) == 1  # no second model call needed


def test_complete_json_regenerates_then_succeeds():
    client, calls = _client_returning(
        "Sorry, no JSON here.",          # attempt 1: unrepairable → regenerate
        '{"job_title": "Care Worker"}',  # attempt 2: clean
    )
    result = _run(client.complete_json(system="s", user="u"))
    assert result == {"job_title": "Care Worker"}
    assert len(calls) == 2
    assert calls[0]["temperature"] == 0.1   # first honours caller default
    assert calls[1]["temperature"] == 0.0   # retry forces deterministic output


def test_complete_json_forwards_operation_to_complete():
    """C67: complete_json previously dropped its caller's operation label
    entirely — unlike complete(), which has always accepted one. Every
    complete_json call site (the majority of this codebase's AI calls) was
    silently attributed to self.operation's constructor-time default in
    the ai_calls telemetry table."""
    client, calls = _client_returning('{"a": 1}')
    _run(client.complete_json(system="s", user="u", operation="structurize_cv"))
    assert calls[0]["operation"] == "structurize_cv"


def test_complete_json_passes_none_through_when_caller_does_not_override():
    """complete_json itself does no fallback — it passes operation=None
    straight to complete(), which is where `op = operation or self.operation`
    actually resolves the default (this test stubs complete() out, so it
    only pins complete_json's own passthrough, not that fallback)."""
    client, calls = _client_returning('{"a": 1}')
    client.operation = "jd_analysis"
    _run(client.complete_json(system="s", user="u"))
    assert calls[0]["operation"] is None


def test_complete_json_exhausts_attempts_and_raises():
    client, calls = _client_returning("still not json")
    with pytest.raises(AIJSONParseError):
        _run(client.complete_json(system="s", user="u", max_attempts=3))
    assert len(calls) == 3


def test_complete_json_does_not_retry_on_billing_error():
    # Billing/rate-limit/auth aren't parse failures — a regen would only burn
    # the user's tokens. They must propagate on the first attempt.
    client, calls = _client_returning(AIBillingError("anthropic", "https://x"))
    with pytest.raises(AIBillingError):
        _run(client.complete_json(system="s", user="u"))
    assert len(calls) == 1
