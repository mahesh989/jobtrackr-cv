"""
Unified AI client supporting Anthropic + OpenAI.

cv-backend is **BYOK** — JobTrackr supplies the user's API key with each
/internal/analyze request, and the key is held only in memory for the
duration of the pipeline run. cv-backend never persists user keys.

Usage:
    client = make_ai_client(provider="anthropic", api_key="sk-ant-...")
    text  = await client.complete(system="...", user="...")
    data  = await client.complete_json(system="...", user="...")
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional

from app.config import get_settings

logger = logging.getLogger(__name__)


class AIClientError(Exception):
    """Raised when the AI client fails (auth, network, parsing)."""


Provider = Literal["anthropic", "openai"]


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
    ) -> str:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise AIClientError("openai package not installed") from exc

        client = AsyncOpenAI(api_key=self.api_key)

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
# Factory — BYOK
# ---------------------------------------------------------------------------


# Sensible default model per provider when JobTrackr does not specify one.
_DEFAULT_MODELS: Dict[Provider, str] = {
    "anthropic": "claude-3-5-sonnet-20241022",
    "openai":    "gpt-4o",
}


def make_ai_client(
    provider: Provider,
    api_key: str,
    model: Optional[str] = None,
) -> AIClient:
    """
    Build an AIClient from values the request carries. No DB lookup, no env keys.
    JobTrackr decrypted the user's BYOK key and passed it in /internal/analyze.

    The key stays only in memory for the lifetime of the pipeline run.
    """
    if not api_key:
        raise AIClientError(f"BYOK api_key is empty for provider={provider}")
    if provider not in ("anthropic", "openai"):
        raise AIClientError(f"Unsupported AI provider: {provider}")

    chosen_model = model or _DEFAULT_MODELS[provider]
    return AIClient(provider=provider, model=chosen_model, api_key=api_key)


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
