"""
Unified AI client supporting Anthropic + OpenAI.

The user's preference (provider/model) is stored in `user_preferences`.
API keys are server-side env vars — users do not supply their own.

Usage:
    client = await get_ai_client_for_user(user_id, db)
    text = await client.complete(system="...", user="...")
    data = await client.complete_json(system="...", user="...", schema_hint=...)
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.user_preference import UserPreference

logger = logging.getLogger(__name__)


class AIClientError(Exception):
    """Raised when the AI client fails (auth, network, parsing)."""


Provider = Literal["anthropic", "openai", "deepseek"]


@dataclass
class AIClient:
    provider: Provider
    model: str
    api_key: str

    # ----------------------------------------------------------------------
    # Public methods
    # ----------------------------------------------------------------------

    async def complete(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> str:
        """Return a plain-text completion."""
        if self.provider == "anthropic":
            return await self._anthropic_complete(
                system=system, user=user, max_tokens=max_tokens, temperature=temperature
            )
        if self.provider == "deepseek":
            return await self._openai_complete(
                system=system, user=user, max_tokens=max_tokens, temperature=temperature,
                base_url=get_settings().DEEPSEEK_BASE_URL,
            )
        return await self._openai_complete(
            system=system, user=user, max_tokens=max_tokens, temperature=temperature
        )

    async def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int = 4096,
        temperature: float = 0.1,
    ) -> Dict[str, Any]:
        """
        Return a parsed JSON object.

        Both providers are nudged via prompt to return raw JSON. We extract
        the first balanced { ... } block and parse it. Raises AIClientError
        on parse failure.
        """
        json_system = (
            system
            + "\n\nRespond with a single valid JSON object. No prose, no markdown fences."
        )
        raw = await self.complete(
            system=json_system, user=user, max_tokens=max_tokens, temperature=temperature
        )
        return _extract_json(raw)

    # ----------------------------------------------------------------------
    # Provider-specific implementations
    # ----------------------------------------------------------------------

    async def _anthropic_complete(
        self, *, system: str, user: str, max_tokens: int, temperature: float
    ) -> str:
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:
            raise AIClientError("anthropic package not installed") from exc

        client = AsyncAnthropic(api_key=self.api_key)
        try:
            response = await client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
        except Exception as exc:
            raise AIClientError(f"Anthropic API error: {exc}") from exc

        # response.content is a list of content blocks; we want the text from the first text block
        for block in response.content:
            if getattr(block, "type", None) == "text":
                return block.text  # type: ignore[no-any-return]

        raise AIClientError("Anthropic returned no text content")

    async def _openai_complete(
        self, *, system: str, user: str, max_tokens: int, temperature: float,
        base_url: Optional[str] = None,
    ) -> str:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise AIClientError("openai package not installed") from exc

        kwargs: Dict[str, Any] = {"api_key": self.api_key}
        if base_url:
            kwargs["base_url"] = base_url
        client = AsyncOpenAI(**kwargs)

        # o-series reasoning models (o1, o3, o4-mini, o3-mini, …) do not
        # support `temperature`; all modern OpenAI models (gpt-4.1+, o-series)
        # require `max_completion_tokens` instead of the deprecated `max_tokens`.
        is_reasoning = (
            self.model.startswith("o1")
            or self.model.startswith("o3")
            or self.model.startswith("o4")
        )

        request_kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # Use max_completion_tokens — accepted by all modern OpenAI models
            # (gpt-4.1, gpt-4o, o-series, gpt-5.x, …). The legacy `max_tokens`
            # alias is unsupported on newer models and causes a 400 error.
            "max_completion_tokens": max_tokens,
        }
        if not is_reasoning:
            # Reasoning models ignore / reject the temperature parameter.
            request_kwargs["temperature"] = temperature

        try:
            response = await client.chat.completions.create(**request_kwargs)
        except Exception as exc:
            raise AIClientError(f"OpenAI API error: {exc}") from exc

        text = response.choices[0].message.content
        if not text:
            raise AIClientError("OpenAI returned empty content")
        return text


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


async def get_ai_client_for_user(user_id: uuid.UUID, db: AsyncSession) -> AIClient:
    """
    Build an AIClient for the given user, using their saved preference.
    Falls back to system defaults if no preference row exists.
    """
    settings = get_settings()

    result = await db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id)
    )
    pref = result.scalar_one_or_none()

    provider: Provider = (
        pref.ai_provider if pref else settings.DEFAULT_AI_PROVIDER
    )  # type: ignore[assignment]
    model = pref.ai_model if pref else settings.DEFAULT_AI_MODEL

    if provider == "anthropic":
        if not settings.ANTHROPIC_API_KEY:
            raise AIClientError(
                "ANTHROPIC_API_KEY is not configured on the server."
            )
        return AIClient(provider="anthropic", model=model, api_key=settings.ANTHROPIC_API_KEY)

    if provider == "openai":
        if not settings.OPENAI_API_KEY:
            raise AIClientError(
                "OPENAI_API_KEY is not configured on the server."
            )
        return AIClient(provider="openai", model=model, api_key=settings.OPENAI_API_KEY)

    if provider == "deepseek":
        if not settings.DEEPSEEK_API_KEY:
            raise AIClientError(
                "DEEPSEEK_API_KEY is not configured on the server."
            )
        return AIClient(provider="deepseek", model=model, api_key=settings.DEEPSEEK_API_KEY)

    raise AIClientError(f"Unknown AI provider: {provider}")


# ---------------------------------------------------------------------------
# JSON extraction helper
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _extract_json(text: str) -> Dict[str, Any]:
    """
    Extract a JSON object from a possibly-noisy LLM response.

    Strategy:
      1. Strip markdown code fences if present.
      2. Try json.loads on the whole stripped string.
      3. Fallback: find the first balanced { ... } block and parse that.
    """
    stripped = _FENCE_RE.sub("", text).strip()

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # Find first balanced { ... } block
    start = stripped.find("{")
    if start == -1:
        raise AIClientError(f"No JSON object found in AI response: {text[:200]}…")

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(stripped)):
        ch = stripped[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = stripped[start : i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError as exc:
                    raise AIClientError(
                        f"Failed to parse JSON: {exc}. Snippet: {candidate[:200]}…"
                    ) from exc

    raise AIClientError(f"Unbalanced JSON object in AI response: {text[:200]}…")
