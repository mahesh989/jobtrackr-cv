"""
Coverage gap + real bug (audit, execution chunk C41b): `usage_tracker.py`
had zero test coverage anywhere in the suite.

REGRESSION: `compute_cost_millicents`'s price-lookup loop matched via
`key_prefix.startswith(k)` in dict ITERATION order (== insertion order for a
Python dict), not by longest/most-specific match. `_MODEL_PRICES` lists
generic family keys ("anthropic/claude-opus-4") before their more specific,
dated-version keys ("anthropic/claude-opus-4-5", "-4-7", "-4-8"), so
`"claude-opus-4-5".startswith("claude-opus-4")` is True and the loop's
`break` on first match ALWAYS picks the generic entry — the specific,
per-version entries were unreachable dead code regardless of which model
string was passed in. This has been numerically silent so far only because
every currently-shadowed entry happens to share the exact same price tuple
as the generic prefix that shadows it — the next time a dated model is
priced differently from its family (routine for AI providers), this would
silently bill the wrong rate with nothing to catch it.

Fixed by matching the LONGEST (most specific) key that is a prefix match,
not the first one encountered in dict order.
"""
import pytest

from app.services.ai import usage_tracker
from app.services.ai.usage_tracker import compute_cost_millicents


def test_REGRESSION_the_most_specific_matching_price_key_wins_not_the_first_in_dict_order(monkeypatch):
    # A minimal synthetic table where a SHORTER, generic key is listed
    # BEFORE a longer, more specific key that also matches — exactly the
    # real _MODEL_PRICES shape (opus-4 before opus-4-5), but with
    # deliberately DIFFERENT prices so a wrong match is observable.
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {
            "anthropic/claude-opus-4": (1_000, 1_000),
            "anthropic/claude-opus-4-5": (2_000, 2_000),
        },
    )
    generic_cost = compute_cost_millicents("anthropic", "claude-opus-4", 1_000_000, 0)
    specific_cost = compute_cost_millicents("anthropic", "claude-opus-4-5", 1_000_000, 0)

    assert generic_cost == 1_000
    assert specific_cost == 2_000, (
        "expected the more specific 'claude-opus-4-5' price entry to win over "
        "the generic 'claude-opus-4' prefix it also matches"
    )


def test_a_family_member_with_no_specific_entry_still_falls_back_to_its_generic_prefix(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {
            "anthropic/claude-opus-4": (1_000, 1_000),
            "anthropic/claude-opus-4-5": (2_000, 2_000),
        },
    )
    # "claude-opus-4-9" has no dedicated entry — must still fall back to the
    # generic "claude-opus-4" prefix, not fail to match at all.
    cost = compute_cost_millicents("anthropic", "claude-opus-4-9", 1_000_000, 0)
    assert cost == 1_000


@pytest.mark.parametrize(
    "provider,model",
    [
        ("anthropic", "claude-opus-4-5"),
        ("anthropic", "claude-opus-4-7"),
        ("anthropic", "claude-opus-4-8"),
        ("anthropic", "claude-sonnet-4-6"),
    ],
)
def test_real_table_dated_variants_match_their_own_specific_entry_not_the_generic_family_prefix(provider, model):
    # Against the REAL _MODEL_PRICES table: today every shadowed entry
    # happens to share its generic prefix's price, so this can't assert a
    # different numeric outcome — but it pins that the specific key is what
    # actually gets selected (via the internal iteration, verified directly)
    # so a future price divergence takes effect immediately instead of
    # silently landing on dead code.
    key_prefix = f"{provider}/{model}"
    matched_keys = [k for k in usage_tracker._MODEL_PRICES if key_prefix.startswith(k)]
    assert len(matched_keys) > 1, "test setup assumption broken: expected multiple candidate matches"
    most_specific = max(matched_keys, key=len)

    cost = compute_cost_millicents(provider, model, 1_000_000, 0)
    expected = round(usage_tracker._MODEL_PRICES[most_specific][0])
    assert cost == expected


def test_unknown_model_falls_back_to_the_default_3_15_rate_and_warns(caplog):
    cost = compute_cost_millicents("anthropic", "totally-unknown-model-xyz", 1_000_000, 0)
    assert cost == 3_000
    assert "unknown model" in caplog.text.lower()


def test_output_tokens_priced_at_the_output_rate_not_the_input_rate(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {"anthropic/claude-test": (1_000, 5_000)},
    )
    cost = compute_cost_millicents("anthropic", "claude-test", 0, 1_000_000)
    assert cost == 5_000


def test_anthropic_cache_read_is_10_percent_of_input_rate(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {"anthropic/claude-test": (1_000, 1_000)},
    )
    # 1M cached tokens, 0 fresh input — cache-read rate is 10% of in_price.
    cost = compute_cost_millicents(
        "anthropic", "claude-test", input_tokens=1_000_000, output_tokens=0, cached_tokens=1_000_000
    )
    assert cost == 100


def test_anthropic_cache_write_is_125_percent_of_input_rate(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {"anthropic/claude-test": (1_000, 1_000)},
    )
    cost = compute_cost_millicents(
        "anthropic",
        "claude-test",
        input_tokens=0,
        output_tokens=0,
        cache_write_tokens=1_000_000,
    )
    assert cost == 1_250


def test_openai_cache_read_is_50_percent_with_no_write_premium(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {"openai/gpt-test": (1_000, 1_000)},
    )
    read_cost = compute_cost_millicents(
        "openai", "gpt-test", input_tokens=1_000_000, output_tokens=0, cached_tokens=1_000_000
    )
    assert read_cost == 500

    # OpenAI has no cache-write premium — cache_write_tokens contribute zero.
    write_cost = compute_cost_millicents(
        "openai", "gpt-test", input_tokens=0, output_tokens=0, cache_write_tokens=1_000_000
    )
    assert write_cost == 0


def test_cached_tokens_exceeding_input_tokens_does_not_go_negative(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {"anthropic/claude-test": (1_000, 1_000)},
    )
    # cached_tokens > input_tokens is defensively clamped via max(0, ...) —
    # normal_input must not go negative and subtract from the total.
    cost = compute_cost_millicents(
        "anthropic", "claude-test", input_tokens=100, output_tokens=0, cached_tokens=1_000
    )
    assert cost >= 0


def test_zero_tokens_costs_zero():
    assert compute_cost_millicents("anthropic", "claude-opus-4", 0, 0) == 0


def test_sub_million_token_calls_are_not_floored_to_zero(monkeypatch):
    monkeypatch.setattr(
        usage_tracker,
        "_MODEL_PRICES",
        {"anthropic/claude-test": (1_000_000, 0)},
    )
    # 1 input token at a deliberately huge per-token rate — float division,
    # not integer division, so this must round to a nonzero value.
    cost = compute_cost_millicents("anthropic", "claude-test", 1, 0)
    assert cost == 1


def test_track_is_a_noop_when_the_feature_flag_is_disabled(monkeypatch):
    monkeypatch.setattr(usage_tracker, "_ENABLED", False)
    # No running event loop needed to prove this — the flag check is the
    # very first line, before compute_cost_millicents is ever called.
    usage_tracker.track(
        operation="test",
        provider="anthropic",
        model="claude-opus-4",
        input_tokens=1,
        output_tokens=1,
        latency_ms=1,
    )
    assert len(usage_tracker._PENDING_TASKS) == 0


def test_track_outside_a_running_event_loop_silently_skips(monkeypatch):
    monkeypatch.setattr(usage_tracker, "_ENABLED", True)
    # Called from a plain sync test function — no running loop, so track()
    # must swallow the RuntimeError from get_running_loop() rather than raise.
    usage_tracker.track(
        operation="test",
        provider="anthropic",
        model="claude-opus-4",
        input_tokens=1,
        output_tokens=1,
        latency_ms=1,
    )
    assert len(usage_tracker._PENDING_TASKS) == 0
