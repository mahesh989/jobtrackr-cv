"""
Single-call cover letter generation pipeline — Phase 10.4 (refactored).

Entry point: run_cover_letter_pipeline(payload)
Scheduled as a FastAPI BackgroundTask by /internal/generate-cover-letter.
Returns 202 immediately; this function runs asynchronously and writes
progress to cover_letters.{letter_id} via Supabase service-role, which
triggers Supabase Realtime events to the browser.

Replaces the previous three-pass (skeleton → voice → burstiness) pipeline.
The new flow:

  Generate  → one call to the user's chosen model with the four-paragraph
              rubric (see prompts/cover_letter/generate.py)
  Honesty   → one call to verify every factual claim ties to the CV.
              On fail with specific claims: one retry with feedback.
              After retry: accept the output, surface warnings in
              quality_flags (decision b — never block the user with no
              output).

DB compatibility:
  - pass_3_final holds the generated body.
  - pass_1_skeleton and pass_2_voice_transferred stay NULL going forward.
  - pass_1_model / pass_2_model / pass_3_model all record the actually-used
    model, so audits do not need to know which column the architecture
    happens to use this week.
  - generation_status JSONB shape simplifies to {generate, honesty}. Old
    completed rows keep their 6-key shape; the UI never re-reads progress
    for rows in a terminal state.

Owns all error handling — never raises. On any unrecovered error, writes
status='failed' with an error_message.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional

from app.database import get_supabase
from app.schemas.cover_letter import GenerateCoverLetterRequest
from app.services.cover_letter.company_name import normalise_company_in_body
from app.services.ai.client import (
    AIClient,
    AIBillingError,
    AIClientError,
    make_ai_client,
)
from app.services.ai.prompts.cover_letter.gate_1_honesty import (
    GATE_1_SYSTEM,
    GATE_1_USER_TEMPLATE,
)
from app.services.ai.prompts.cover_letter.generate import (
    HONESTY_RETRY_TEMPLATE,
    SYSTEM,
    SYSTEM_BODY_ONLY,
    USER_TEMPLATE,
    USER_TEMPLATE_BODY_ONLY,
    format_story,
    format_unsupported_claims,
)

logger = logging.getLogger(__name__)

_AU_UNIT_CODE_INLINE_RE = re.compile(
    r"\b(?:HLT|CHC|BSB|FSK|SIT|CPP|AHC|HLTHPS|HLTAID|HLTINF|HLTWHS)[A-Z0-9]{2,6}\b",
    re.IGNORECASE,
)


def strip_vet_codes_from_cover_letter(text: str) -> str:
    """
    Strip Australian VET unit codes (CHC43015, HLTAID011, etc.) from the cover letter text,
    including surrounding parentheses or trailing/leading hyphens/dashes/colons/spaces.
    """
    if not text:
        return text

    # 1. Strip "(CODE)" form first, e.g. "Certificate IV in Ageing Support (CHC43015)"
    out = re.sub(
        r"\s*\(\s*" + _AU_UNIT_CODE_INLINE_RE.pattern + r"\s*\)",
        "",
        text,
        flags=re.IGNORECASE
    )

    # 2. Strip "CODE - " or "CODE: " or "CODE – " form, e.g. "CHC43015 - Certificate IV"
    out = re.sub(
        r"\b" + _AU_UNIT_CODE_INLINE_RE.pattern + r"\b\s*[-–—:]\s*",
        "",
        out,
        flags=re.IGNORECASE
    )

    # 3. Strip " - CODE" or " – CODE" form, e.g. "Certificate IV - CHC43015"
    out = re.sub(
        r"\s*[-–—:]\s*\b" + _AU_UNIT_CODE_INLINE_RE.pattern + r"\b",
        "",
        out,
        flags=re.IGNORECASE
    )

    # 4. Strip bare CODE, e.g. "CHC43015 Certificate IV"
    out = re.sub(
        r"\b" + _AU_UNIT_CODE_INLINE_RE.pattern + r"\b\s*",
        "",
        out,
        flags=re.IGNORECASE
    )

    # Clean up double spaces
    out = re.sub(r" {2,}", " ", out)

    return out.strip()

_TABLE = "cover_letters"

# Cap on cv_text passed into the prompt. Controls token cost across providers
# and matches the cap used by the honesty gate so both calls see the same CV.
_CV_TEXT_CAP = 8000

# Cap on JD text. Tailoring signal, not direct quotation — generous middle
# ground that still fits comfortably alongside cv_text in a single prompt.
_JD_TEXT_CAP = 1500

# 400 words ≈ 600 tokens; allow headroom for varied phrasing.
_GENERATE_MAX_TOKENS = 1200


def _generation_temperature(model: str) -> float:
    """
    OpenAI silently forces temperature=1.0 on the entire gpt-5* family — any
    other value passed via the API is ignored. Return 1.0 for those models so
    the code reflects reality. Use 0.7 for everything else (higher than the
    AIClient default of 0.3) to give meaningful variation across regenerations
    of the same JD.
    """
    if model.lower().startswith("gpt-5"):
        return 1.0
    return 0.7

# Fallback model per provider when the user's integration has no model set.
# Chosen as the best generally-available model for each provider — the user's
# integration choice always wins; this is the "they did not pick" branch.
_PROVIDER_DEFAULT_MODEL: Dict[str, str] = {
    "anthropic": "claude-opus-4-7",
    "openai":    "gpt-4o",
    "deepseek":  "deepseek-chat",
}


# ── Supabase persistence ──────────────────────────────────────────────────────

async def _patch(letter_id: str, patch: Dict[str, Any]) -> None:
    """Persist a partial update to the cover_letters row. Supabase-py is sync."""
    def _do() -> None:
        get_supabase().table(_TABLE).update(patch).eq("id", letter_id).execute()
    await asyncio.to_thread(_do)


async def _read_quality_flags(letter_id: str) -> Dict[str, Any]:
    """
    Read existing quality_flags from the row so the web layer's pre-write
    warnings (e.g. low_quality_company_research) survive the generator's
    final write. Returns {} if the row is missing or the column is null.
    """
    def _do() -> Any:
        return (
            get_supabase()
            .table(_TABLE)
            .select("quality_flags")
            .eq("id", letter_id)
            .single()
            .execute()
        )
    try:
        result = await asyncio.to_thread(_do)
        existing = (result.data or {}).get("quality_flags") if result else None
        return existing if isinstance(existing, dict) else {}
    except Exception:
        return {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _initial_status() -> Dict[str, str]:
    return {"generate": "pending", "honesty": "pending"}


# ── Honesty gate ──────────────────────────────────────────────────────────────

async def _run_honesty_gate(
    client: AIClient,
    letter_text: str,
    cv_text: str,
) -> tuple[bool, List[str]]:
    """
    Verify every factual claim in the letter against the CV.
    Returns (passed, unsupported_claims). On AI failure, returns (True, [])
    so a transient gate problem does not block the user from seeing output.
    """
    user = GATE_1_USER_TEMPLATE.format(
        letter_text=letter_text,
        master_cv_text=cv_text[:_CV_TEXT_CAP],
    )
    try:
        result = await client.complete_json(
            system=GATE_1_SYSTEM,
            user=user,
            max_tokens=512,
            temperature=0.1,
            no_training=True,
        )
        passed = result.get("result", "fail") == "pass"
        raw_unsupported = result.get("unsupported_claims") or []
        unsupported = (
            [str(c) for c in raw_unsupported if c]
            if isinstance(raw_unsupported, list)
            else []
        )
        return passed, unsupported
    except AIClientError as exc:
        logger.warning("honesty gate call failed (%s) — treating as pass", exc)
        return True, []


# ── Main generation call ──────────────────────────────────────────────────────

async def _generate_body(
    client: AIClient,
    payload: GenerateCoverLetterRequest,
    *,
    primary_story_block: str,
    secondary_story_block: str,
    honesty_retry_block: str,
) -> str:
    """One call to the user's chosen model. Returns the body text."""
    user = USER_TEMPLATE.format(
        voice_sample=payload.voice_sample_text,
        cv_text=payload.cv_text[:_CV_TEXT_CAP],
        primary_story=primary_story_block,
        secondary_story=secondary_story_block,
        role=payload.role,
        company_name=payload.company_name,
        company_fact=payload.company_hook_text,
        jd_priorities=payload.jd_text[:_JD_TEXT_CAP],
        honesty_retry_block=honesty_retry_block,
    )
    return await client.complete(
        system=SYSTEM,
        user=user,
        max_tokens=_GENERATE_MAX_TOKENS,
        temperature=_generation_temperature(client.model),
        no_training=True,
    )


async def _generate_body_with_chosen_opener(
    client: AIClient,
    payload: GenerateCoverLetterRequest,
    *,
    primary_story_block: str,
    secondary_story_block: str,
    honesty_retry_block: str,
) -> str:
    """
    Write P2-P4 only, treating payload.chosen_opening as the fixed P1.

    The returned string is P2-P4 prose only — the caller prepends
    chosen_opening + a blank line before storing in pass_3_final so the
    honesty gate sees the complete combined letter.
    """
    user = USER_TEMPLATE_BODY_ONLY.format(
        voice_sample=payload.voice_sample_text,
        cv_text=payload.cv_text[:_CV_TEXT_CAP],
        primary_story=primary_story_block,
        secondary_story=secondary_story_block,
        role=payload.role,
        company_name=payload.company_name,
        company_fact=payload.company_hook_text,
        jd_priorities=payload.jd_text[:_JD_TEXT_CAP],
        chosen_opening=payload.chosen_opening,
        honesty_retry_block=honesty_retry_block,
    )
    return await client.complete(
        system=SYSTEM_BODY_ONLY,
        user=user,
        max_tokens=_GENERATE_MAX_TOKENS,
        temperature=_generation_temperature(client.model),
        no_training=True,
    )


# ── Pipeline orchestrator ─────────────────────────────────────────────────────

# Pipeline-level retry for the GENERATE step. The AI client already retries
# connection/timeout/overload a couple of times, but during an auto-analyze
# batch a burst of concurrent cover-letter generations can exhaust those and
# blow past a rate-limit / 529-overload window — permanently marking the letter
# 'failed' so a high-ATS job never reaches the application pool. A pipeline-level
# retry with longer, jittered backoff lets the provider recover so a transient
# blip doesn't strand the letter. Billing errors are permanent — never retried.
_GENERATE_MAX_ATTEMPTS = 3
_GENERATE_RETRY_BASE_S = 5.0   # backoff doubles each attempt (~5s, ~10s) + jitter


async def _generate_with_retry(
    attempt: Callable[[], Coroutine[Any, Any, str]],
    letter_id: str,
) -> str:
    last: Optional[AIClientError] = None
    for i in range(_GENERATE_MAX_ATTEMPTS):
        try:
            return await attempt()
        except AIBillingError:
            raise  # out of credit/quota — retrying won't help
        except AIClientError as exc:
            last = exc
            if i < _GENERATE_MAX_ATTEMPTS - 1:
                delay = _GENERATE_RETRY_BASE_S * (2 ** i) + random.uniform(0, _GENERATE_RETRY_BASE_S)
                logger.warning(
                    "cover letter %s: generate attempt %d/%d failed (%s) — retrying in %.0fs",
                    letter_id, i + 1, _GENERATE_MAX_ATTEMPTS, exc, delay,
                )
                await asyncio.sleep(delay)
    assert last is not None
    raise last


async def run_cover_letter_pipeline(payload: GenerateCoverLetterRequest) -> None:
    """Execute the single-call cover letter pipeline. Never raises."""
    letter_id = payload.letter_id
    model = payload.ai_model or _PROVIDER_DEFAULT_MODEL.get(payload.ai_provider, "")

    if not model:
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"No model available for provider '{payload.ai_provider}'",
            "completed_at": _now_iso(),
        })
        return

    try:
        client = make_ai_client(
            provider=payload.ai_provider,
            api_key=payload.ai_api_key,
            model=model,
        )
    except AIClientError as exc:
        logger.error("cover letter %s: AI client init failed: %s", letter_id, exc)
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"AI client initialisation failed: {exc}",
            "completed_at": _now_iso(),
        })
        return

    # Preserve any quality_flags the web layer pre-wrote (e.g. the
    # low_quality_company_research warning surfaced when company research
    # found nothing actionable and we fell back to the JD-derived hook).
    pre_flags = await _read_quality_flags(letter_id)

    # Mark running. Record the actually-used model in all three model columns
    # so existing audit queries keep working regardless of which they read.
    await _patch(letter_id, {
        "status": "running",
        "started_at": _now_iso(),
        "generation_status": _initial_status(),
        "pass_1_model": model,
        "pass_2_model": model,
        "pass_3_model": model,
    })

    primary_story_block = format_story(payload.story)
    # Secondary-story plumbing is not yet wired in the web route — emits
    # "(none available)" and the prompt naturally adapts (paragraph 3 only
    # adds the secondary "if it exists and fits").
    secondary_story_block = format_story(None)

    try:
        # ── Generate ──────────────────────────────────────────────────────
        await _patch(letter_id, {
            "generation_status": {"generate": "running", "honesty": "pending"},
        })

        async def _attempt_generate() -> str:
            if payload.chosen_opening:
                # Phase 11 path: user picked a P1 opener — write P2-4 only,
                # then prepend the chosen opener so the honesty gate sees the
                # complete letter.
                p2_4 = await _generate_body_with_chosen_opener(
                    client, payload,
                    primary_story_block=primary_story_block,
                    secondary_story_block=secondary_story_block,
                    honesty_retry_block="",
                )
                return payload.chosen_opening.rstrip() + "\n\n" + p2_4.lstrip()
            return await _generate_body(
                client, payload,
                primary_story_block=primary_story_block,
                secondary_story_block=secondary_story_block,
                honesty_retry_block="",
            )

        body = await _generate_with_retry(_attempt_generate, letter_id)

        # Guarantee the prompt's "full name once, short form after" rule
        # deterministically — the model is best-effort about it.
        body = normalise_company_in_body(body, payload.company_name)
        body = strip_vet_codes_from_cover_letter(body)

        await _patch(letter_id, {
            "pass_3_final": body,
            "generation_status": {"generate": "completed", "honesty": "pending"},
        })

        # ── Honesty gate ──────────────────────────────────────────────────
        await _patch(letter_id, {
            "generation_status": {"generate": "completed", "honesty": "running"},
        })

        passed, unsupported = await _run_honesty_gate(client, body, payload.cv_text)
        quality_flags: Dict[str, Any] = {}
        honesty_ok = passed

        if not passed and unsupported:
            # One retry with the unsupported claims fed back into the prompt.
            logger.info(
                "cover letter %s: honesty gate failed (%d claims), retrying",
                letter_id, len(unsupported),
            )
            retry_block = HONESTY_RETRY_TEMPLATE.format(
                unsupported_claims=format_unsupported_claims(unsupported),
            )
            try:
                if payload.chosen_opening:
                    p2_4_retry = await _generate_body_with_chosen_opener(
                        client, payload,
                        primary_story_block=primary_story_block,
                        secondary_story_block=secondary_story_block,
                        honesty_retry_block=retry_block,
                    )
                    body = payload.chosen_opening.rstrip() + "\n\n" + p2_4_retry.lstrip()
                else:
                    body = await _generate_body(
                        client, payload,
                        primary_story_block=primary_story_block,
                        secondary_story_block=secondary_story_block,
                        honesty_retry_block=retry_block,
                    )
                body = normalise_company_in_body(body, payload.company_name)
                body = strip_vet_codes_from_cover_letter(body)
                await _patch(letter_id, {"pass_3_final": body})
                passed_2, unsupported_2 = await _run_honesty_gate(
                    client, body, payload.cv_text,
                )
                quality_flags["honesty_retried"] = True
                quality_flags["honesty_passed_after_retry"] = passed_2
                honesty_ok = passed_2
                if not passed_2 and unsupported_2:
                    # Decision (b): accept output, surface warning in flags.
                    quality_flags["unsupported_claims"] = unsupported_2
            except AIClientError as exc:
                logger.warning(
                    "cover letter %s: honesty retry failed: %s", letter_id, exc,
                )
                quality_flags["honesty_retry_error"] = str(exc)
                quality_flags["unsupported_claims"] = unsupported
                # honesty_ok stays False — first-attempt failure stands.

        elif not passed and not unsupported:
            # Gate said fail but enumerated no claims — we cannot act on it.
            # Surface the inconclusive state but do not block the output.
            quality_flags["honesty_inconclusive"] = True
            honesty_ok = True

        # ── Persist final state ───────────────────────────────────────────
        # Merge: web-layer warnings first, generator-side flags override
        # only if they share a key (they should not).
        merged_flags: Dict[str, Any] = {**pre_flags, **quality_flags}
        await _patch(letter_id, {
            "status": "completed",
            "honesty_ok": honesty_ok,
            "quality_flags": merged_flags,
            "generation_status": {"generate": "completed", "honesty": "completed"},
            "completed_at": _now_iso(),
        })
        logger.info("cover letter %s: completed (honesty_ok=%s)", letter_id, honesty_ok)

    except AIClientError as exc:
        logger.error("cover letter %s: AI call failed: %s", letter_id, exc)
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"AI generation failed: {exc}",
            "completed_at": _now_iso(),
        })
    except Exception as exc:  # noqa: BLE001 — top-level safety net
        logger.exception("cover letter %s: unexpected error", letter_id)
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"Unexpected error: {exc}",
            "completed_at": _now_iso(),
        })
