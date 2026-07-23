"""
AI usage tracker — emits one ai_calls row per LLM API call.

Design:
  * Entirely fire-and-forget: errors never propagate to the caller.
  * Uses the service-role Supabase client (same as the orchestrator).
  * Disabled by default (TRACK_AI_USAGE=false) so existing Fly deploy is
    inert; flip the env var to 'true' after applying migration 055.
  * Runs in a background asyncio task so it never adds latency to the
    pipeline. The caller should call track() and forget it.

Usage (inside AIClient._anthropic_complete after response arrives):
    asyncio.create_task(
        usage_tracker.track(
            user_id=user_id,
            run_id=run_id,
            operation=operation,
            provider="anthropic",
            model=self.model,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cached_tokens=getattr(response.usage, "cache_read_input_tokens", 0),
            cost_millicents=_price(self.model, "anthropic", in_t, out_t),
            latency_ms=latency_ms,
            retry_count=attempt,
            status="ok",
        )
    )
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from app.enums import Provider

logger = logging.getLogger(__name__)

# Feature flag — flip to 'true' in Fly secrets after applying migration 055.
_ENABLED = os.getenv("TRACK_AI_USAGE", "false").lower() == "true"

# Strong references to in-flight emit tasks — create_task results are weakly
# held, so an unreferenced task can be GC'd before it runs. Discarded on done.
_PENDING_TASKS: set = set()

# ── Model price table ─────────────────────────────────────────────────────────
# Cost in millicents per token (USD cents × 1000 per token).
# Sources: Anthropic pricing page / OpenAI pricing page.
# Update this dict when Anthropic/OpenAI change pricing — no migration needed.
#
# Key format: "<provider>/<model-slug-prefix>" — we match by startswith so
#   "claude-sonnet-4" matches "claude-sonnet-4-6", "claude-sonnet-4-7" etc.
#
# (input_millicents_per_token, output_millicents_per_token)
_MODEL_PRICES: dict[str, tuple[int, int]] = {
    # Anthropic — prices as of 2026-06 (USD per 1M tokens → millicents/token)
    "anthropic/claude-opus-4":    (15_000, 75_000),   # $15/$75 /MTok
    "anthropic/claude-opus-4-5":  (15_000, 75_000),
    "anthropic/claude-opus-4-7":  (15_000, 75_000),
    "anthropic/claude-opus-4-8":  (15_000, 75_000),
    "anthropic/claude-sonnet-4":  ( 3_000, 15_000),   # $3/$15 /MTok
    "anthropic/claude-sonnet-4-6":( 3_000, 15_000),
    "anthropic/claude-haiku-4":   (   800,  4_000),   # $0.80/$4 /MTok
    "anthropic/claude-3-5-sonnet":( 3_000, 15_000),
    "anthropic/claude-3-5-haiku": (   800,  4_000),
    "anthropic/claude-3-opus":    (15_000, 75_000),
    # OpenAI
    "openai/gpt-4o":              ( 2_500, 10_000),   # $2.50/$10 /MTok
    "openai/gpt-4o-mini":         (   150,    600),
    "openai/gpt-4-turbo":         (10_000, 30_000),
    "openai/gpt-4":               (30_000, 60_000),
    "openai/o3":                  (10_000, 40_000),
    "openai/o4-mini":             ( 1_100,  4_400),
    # DeepSeek
    "deepseek/deepseek-chat":     (   270,  1_100),   # $0.27/$1.10 /MTok
    "deepseek/deepseek-reasoner": (   550,  2_190),
}

# Cache pricing multipliers.
# Anthropic: reads = 10% of input; writes = 125% of input.
# OpenAI:    cached prompt tokens = 50% of input (no write premium).
_ANTHROPIC_CACHE_READ  = 0.10
_ANTHROPIC_CACHE_WRITE = 1.25
_OPENAI_CACHE_READ     = 0.50


def compute_cost_millicents(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cached_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> int:
    """Return total cost in USD millicents for a single LLM call.

    Uses float arithmetic (rounded at the end) so sub-million-token calls
    are not silently floored to zero by integer division.
    """
    key_prefix = f"{provider}/{model}"
    price_entry = None
    for k, v in _MODEL_PRICES.items():
        if key_prefix.startswith(k):
            price_entry = v
            break

    if price_entry is None:
        logger.warning("usage_tracker: unknown model %s/%s — using $3/$15 pricing", provider, model)
        price_entry = (3_000, 15_000)

    in_price, out_price = price_entry

    # Non-cached input tokens (input_tokens already includes cached reads).
    normal_input = max(0, input_tokens - cached_tokens)

    if provider == Provider.ANTHROPIC:
        cache_read_rate  = in_price * _ANTHROPIC_CACHE_READ
        cache_write_rate = in_price * _ANTHROPIC_CACHE_WRITE
    else:
        # OpenAI (and fallback): cached prompt tokens at 50%, no write premium.
        cache_read_rate  = in_price * _OPENAI_CACHE_READ
        cache_write_rate = 0.0

    cost = (
        normal_input       * in_price         / 1_000_000
        + cached_tokens    * cache_read_rate  / 1_000_000
        + cache_write_tokens * cache_write_rate / 1_000_000
        + output_tokens    * out_price        / 1_000_000
    )
    return round(cost)


async def _emit(row: dict) -> None:
    """Insert one ai_calls row. Runs as a background task — never raises."""
    try:
        from app.database import get_supabase
        await asyncio.to_thread(
            lambda: get_supabase().table("ai_calls").insert(row).execute()
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("usage_tracker: failed to emit ai_calls row: %s", exc)


def track(
    *,
    operation: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    latency_ms: int,
    cached_tokens: int = 0,
    cache_write_tokens: int = 0,
    retry_count: int = 0,
    status: str = "ok",
    error_type: Optional[str] = None,
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> None:
    """
    Fire-and-forget: schedule an ai_calls insert as an asyncio background task.

    Call with asyncio.get_event_loop().create_task(track(...)) is NOT needed —
    track() itself creates the task if there is a running loop, or silently
    skips if called outside an async context (e.g. tests).

    If TRACK_AI_USAGE != 'true', this is a no-op.
    """
    if not _ENABLED:
        return

    cost = compute_cost_millicents(
        provider, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens
    )

    row: dict = {
        "operation":          operation,
        "provider":           provider,
        "model":              model,
        "input_tokens":       input_tokens,
        "output_tokens":      output_tokens,
        "cached_tokens":      cached_tokens,
        "cost_millicents":    cost,
        "latency_ms":         latency_ms,
        "retry_count":        retry_count,
        "status":             status,
    }
    if user_id:
        row["user_id"] = str(user_id)
    if run_id:
        row["run_id"] = str(run_id)
    if error_type:
        row["error_type"] = error_type

    try:
        loop = asyncio.get_running_loop()
        task = loop.create_task(_emit(row))
        _PENDING_TASKS.add(task)
        task.add_done_callback(_PENDING_TASKS.discard)
    except RuntimeError:
        # No running event loop (e.g. sync test context) — silently skip.
        pass
