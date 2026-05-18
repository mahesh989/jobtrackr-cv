"""
Model routing for the three-pass cover letter pipeline.

IMPORTANT — these model constants are intentional overrides of the user's
preferred model setting. The three-pass pipeline hard-codes tier selection:

  Pass 1 (skeleton) and Pass 3 (burstiness) → cheap tier
  Pass 2 (voice transfer)                   → expensive tier

This is a deliberate product decision (cover-letter-spec.md D4): allowing users
to downgrade Pass 2 to a cheap model defeats the quality/cost tradeoff at the
core of the system. The user's ai_provider and api_key are honoured; only the
model selection is overridden.

BUG-2 note: Do NOT route Pass 2 to GPT-5* models — OpenAI enforces
temperature=1 on the entire gpt-5* family, which breaks the deterministic
rewrite quality of voice transfer. Use gpt-4o for the expensive OpenAI tier.
See graph.json known_issues BUG-2 for full context.

Model IDs are pinned to the catalogue verified at Phase 10.4 build time
(2026-05-18). Review against the live ProviderPicker model list before
promoting to production if significant time has passed.
"""
from __future__ import annotations

from app.services.ai.client import AIClient, AIClientError, Provider, make_ai_client

# ── Cheap tier ────────────────────────────────────────────────────────────────
# Used for: Pass 1 (skeleton), Pass 3 (burstiness), Gate 1 (honesty check).
# Short context, short output — cost-optimised.
_CHEAP_MODELS: dict[Provider, str] = {
    "anthropic": "claude-haiku-4-5-20251001",
    "openai":    "gpt-4o-mini",
    "deepseek":  "deepseek-chat",
}

# ── Expensive tier ────────────────────────────────────────────────────────────
# Used for: Pass 2 (voice transfer) only.
# This is where the quality investment is made — must be the most capable
# available model from the user's provider.
# OpenAI: gpt-4o (NOT gpt-5* per BUG-2 above).
# DeepSeek: no meaningful expensive tier — falls back to deepseek-chat.
_EXPENSIVE_MODELS: dict[Provider, str] = {
    "anthropic": "claude-opus-4-7",
    "openai":    "gpt-4o",
    "deepseek":  "deepseek-chat",
}


def make_cheap_client(provider: Provider, api_key: str) -> AIClient:
    """Return an AIClient configured for the cheap model tier."""
    model = _CHEAP_MODELS.get(provider)
    if not model:
        raise AIClientError(f"No cheap-tier model configured for provider: {provider}")
    return make_ai_client(provider=provider, api_key=api_key, model=model)


def make_expensive_client(provider: Provider, api_key: str) -> AIClient:
    """Return an AIClient configured for the expensive model tier (Pass 2)."""
    model = _EXPENSIVE_MODELS.get(provider)
    if not model:
        raise AIClientError(f"No expensive-tier model configured for provider: {provider}")
    return make_ai_client(provider=provider, api_key=api_key, model=model)
