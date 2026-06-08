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

import asyncio as _asyncio_mod

from app.config import get_settings

logger = logging.getLogger(__name__)

# Transient connection errors worth retrying (HTTP/2 resets, TCP drops).
_TRANSIENT_PATTERNS = (
    "connectionterminated",
    "connectionreset",
    "connection reset",
    "remotedisconnected",
    "remote end closed connection",
    "server disconnected",
    "broken pipe",
    "incomplete chunked read",
    "connection closed",
)

_MAX_RETRIES = 2
_RETRY_BASE_DELAY = 1.5  # seconds; doubles each attempt


def _is_transient(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(p in msg for p in _TRANSIENT_PATTERNS)


class AIClientError(Exception):
    """Raised when the AI client fails (auth, network, parsing)."""


Provider = Literal["anthropic", "openai", "deepseek"]

# DeepSeek exposes an OpenAI-compatible REST surface at a different host.
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"


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
        no_training: bool = False,
    ) -> str:
        """Return a plain-text completion."""
        if self.provider == "anthropic":
            return await self._anthropic_complete(
                system=system, user=user, max_tokens=max_tokens,
                temperature=temperature, no_training=no_training,
            )
        # DeepSeek shares OpenAI's wire format; only the base URL differs.
        base_url = DEEPSEEK_BASE_URL if self.provider == "deepseek" else None
        return await self._openai_complete(
            system=system, user=user, max_tokens=max_tokens, temperature=temperature,
            base_url=base_url, no_training=no_training,
        )

    async def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int = 4096,
        temperature: float = 0.1,
        no_training: bool = False,
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
            system=json_system, user=user, max_tokens=max_tokens,
            temperature=temperature, no_training=no_training,
        )
        return _extract_json(raw)

    # ----------------------------------------------------------------------
    # Provider-specific implementations
    # ----------------------------------------------------------------------

    async def _anthropic_complete(
        self, *, system: str, user: str, max_tokens: int, temperature: float,
        no_training: bool = False,
    ) -> str:
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:
            raise AIClientError("anthropic package not installed") from exc

        client = AsyncAnthropic(api_key=self.api_key)

        if no_training:
            # TODO: Anthropic SDK 0.97 has no public no-training API parameter.
            # When Anthropic documents one, pass it here via extra_headers or a
            # native param. Provider default data policy applies until then.
            pass

        # Some newer Anthropic models (Opus 4.7+, including 4.8) reject the
        # `temperature` parameter with HTTP 400:
        #   "`temperature` is deprecated for this model."
        # Rather than maintain a model allow/denylist that drifts as Anthropic
        # adds versions, mirror the OpenAI path: try with temperature, catch
        # the specific error, retry once without. This keeps the tuned 0.1
        # temperature for older Claude models that still accept it.
        async def _call(tokens: int, include_temperature: bool = True):
            kwargs: Dict[str, Any] = {
                "model": self.model,
                "max_tokens": tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }
            if include_temperature:
                kwargs["temperature"] = temperature
            return await client.messages.create(**kwargs)

        last_exc: Optional[Exception] = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                try:
                    response = await _call(max_tokens)
                except Exception as exc:
                    msg = str(exc)
                    temp_deprecated = (
                        "temperature" in msg.lower()
                        and ("deprecated" in msg.lower()
                             or "not supported" in msg.lower()
                             or "unsupported" in msg.lower())
                    )
                    if temp_deprecated:
                        logger.info(
                            "Anthropic model %s rejected temperature; retrying without it.",
                            self.model,
                        )
                        response = await _call(max_tokens, include_temperature=False)
                    else:
                        raise
                # Auto-retry once on max_tokens truncation
                if getattr(response, "stop_reason", None) == "max_tokens":
                    logger.info(
                        "Anthropic hit max_tokens (%d) for model %s; retrying with doubled cap.",
                        max_tokens, self.model,
                    )
                    response = await _call(max_tokens * 2)
                break  # success
            except Exception as exc:
                if _is_transient(exc) and attempt < _MAX_RETRIES:
                    delay = _RETRY_BASE_DELAY * (2 ** attempt)
                    logger.warning(
                        "Anthropic transient error (attempt %d/%d): %s — retrying in %.1fs",
                        attempt + 1, _MAX_RETRIES + 1, exc, delay,
                    )
                    last_exc = exc
                    await _asyncio_mod.sleep(delay)
                    continue
                raise AIClientError(f"Anthropic API error: {exc}") from exc
        else:
            raise AIClientError(f"Anthropic API error after {_MAX_RETRIES + 1} attempts: {last_exc}") from last_exc

        # response.content is a list of content blocks; we want the text from the first text block
        for block in response.content:
            if getattr(block, "type", None) == "text":
                return block.text  # type: ignore[no-any-return]

        raise AIClientError("Anthropic returned no text content")

    async def _openai_complete(
        self, *, system: str, user: str, max_tokens: int, temperature: float,
        base_url: Optional[str] = None, no_training: bool = False,
    ) -> str:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise AIClientError("openai package not installed") from exc

        kwargs: Dict[str, Any] = {"api_key": self.api_key}
        if base_url:
            kwargs["base_url"] = base_url
        client = AsyncOpenAI(**kwargs)

        # o-series reasoning models (o1, o3, o4) NEVER accept custom
        # temperature. gpt-5.x is mixed — some sub-versions accept it
        # (e.g. gpt-5.1, gpt-5.2 in observed runs), others reject it
        # with HTTP 400 `unsupported_value` (e.g. gpt-5.5). Rather than
        # blanket-strip the whole gpt-5 family (which forced cv-magic's
        # carefully-tuned 0.1 temperature up to OpenAI's default of 1
        # and noticeably degraded extraction quality), we now:
        #   1. Always strip for o-series — they universally reject.
        #   2. Send temperature for everything else, including gpt-5.x.
        #   3. If OpenAI returns the specific temperature-unsupported
        #      error, retry once without temperature.
        skip_temperature = (
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
            "max_completion_tokens": max_tokens,
        }
        if not skip_temperature:
            request_kwargs["temperature"] = temperature
        if no_training:
            # Opt out of OpenAI using this completion for model training.
            # TODO: DeepSeek is OpenAI-compatible but does not document 'store';
            # passing it is likely a no-op — verify when DeepSeek publishes API docs.
            request_kwargs["store"] = False

        async def _do_call(kwargs: Dict[str, Any]):
            try:
                return await client.chat.completions.create(**kwargs)
            except Exception as exc:
                msg = str(exc)
                # Heuristic match — covers both the SDK's string form and
                # the raw {'error': {'message': '...'}} envelope.
                temp_unsupported = (
                    "'temperature'" in msg
                    and ("unsupported_value" in msg.lower()
                         or "does not support" in msg.lower())
                )
                if temp_unsupported and "temperature" in kwargs:
                    # Retry without temperature — model enforces default=1.
                    logger.info(
                        "Model %s rejected custom temperature; retrying with default.",
                        self.model,
                    )
                    retry = {k: v for k, v in kwargs.items() if k != "temperature"}
                    return await client.chat.completions.create(**retry)
                # Detect legacy completions-only models (e.g. gpt-3.5-turbo-instruct)
                # that don't support the chat/completions endpoint.
                not_chat_model = (
                    "not a chat model" in msg.lower()
                    or "v1/completions" in msg.lower()
                )
                if not_chat_model:
                    fallback_model = "gpt-4o"
                    logger.warning(
                        "Model '%s' is not a chat model; falling back to '%s'. "
                        "Update your AI key settings to use a supported model.",
                        kwargs.get("model"), fallback_model,
                    )
                    retry = {**kwargs, "model": fallback_model}
                    return await client.chat.completions.create(**retry)
                raise

        last_exc: Optional[Exception] = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                response = await _do_call(request_kwargs)
                finish_reason = (
                    response.choices[0].finish_reason if response.choices else None
                )
                logger.info(
                    "OpenAI response for %s: finish_reason=%s, length=%d chars",
                    self.model, finish_reason,
                    len(response.choices[0].message.content or "") if response.choices else 0,
                )
                content = response.choices[0].message.content if response.choices else ""
                looks_truncated = (
                    content and not content.rstrip().endswith(("}", "]", "\"", ".", "`"))
                )
                should_retry = (
                    finish_reason in ("length", "incomplete")
                    or (finish_reason != "stop" and looks_truncated)
                )
                if should_retry:
                    logger.info(
                        "Retrying for model %s (finish_reason=%s, looks_truncated=%s) "
                        "with doubled max_completion_tokens.",
                        self.model, finish_reason, looks_truncated,
                    )
                    bumped = {
                        **request_kwargs,
                        "max_completion_tokens": request_kwargs["max_completion_tokens"] * 2,
                    }
                    response = await _do_call(bumped)
                break  # success
            except Exception as exc:
                if _is_transient(exc) and attempt < _MAX_RETRIES:
                    delay = _RETRY_BASE_DELAY * (2 ** attempt)
                    logger.warning(
                        "OpenAI transient error (attempt %d/%d): %s — retrying in %.1fs",
                        attempt + 1, _MAX_RETRIES + 1, exc, delay,
                    )
                    last_exc = exc
                    await _asyncio_mod.sleep(delay)
                    continue
                raise AIClientError(f"OpenAI API error: {exc}") from exc
        else:
            raise AIClientError(f"OpenAI API error after {_MAX_RETRIES + 1} attempts: {last_exc}") from last_exc

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
    "deepseek":  "deepseek-chat",
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
    if provider not in ("anthropic", "openai", "deepseek"):
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
