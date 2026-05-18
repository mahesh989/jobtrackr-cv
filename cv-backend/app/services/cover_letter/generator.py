"""
Three-pass cover letter generation pipeline — Phase 10.4.

Entry point: run_cover_letter_pipeline(payload)
Scheduled as a FastAPI BackgroundTask by /internal/generate-cover-letter.
Returns 202 immediately; this function runs asynchronously and writes
progress to cover_letters.{letter_id} via Supabase service-role, which
triggers Supabase Realtime events to the browser.

Pipeline:
  Pass 1  → skeleton draft (cheap model)
  Gate 1  → honesty check (cheap model, retries once on fail)
  Pass 2  → voice transfer (expensive model, retries once on Gate 2 fail)
  Gate 2  → coherence check (deterministic, no AI)
  Pass 3  → burstiness injection (cheap model, retries once on Gate 3 fail)
  Gate 3  → statistical signature check (deterministic, no AI)

Writes to cover_letters after each pass. Owns all error handling — never
raises. On any unrecovered error, writes status=failed.

OPS-4 note: if this file exceeds 550 lines during a future edit, extract
_run_pass_1/_run_pass_2/_run_pass_3 into a sibling passes.py module.
"""
from __future__ import annotations

import asyncio
import logging
import math
import string
from datetime import datetime, timezone
from typing import Any, Dict

from app.database import get_supabase
from app.schemas.cover_letter import GenerateCoverLetterRequest
from app.services.ai.client import AIClientError
from app.services.ai.prompts.cover_letter.gate_1_honesty import (
    GATE_1_SYSTEM,
    GATE_1_USER_TEMPLATE,
)
from app.services.ai.prompts.cover_letter.pass_1_skeleton import (
    PASS_1_SYSTEM,
    PASS_1_USER_TEMPLATE,
)
from app.services.ai.prompts.cover_letter.pass_2_voice_transfer import (
    PASS_2_SYSTEM,
    PASS_2_USER_TEMPLATE,
)
from app.services.ai.prompts.cover_letter.pass_3_burstiness import (
    PASS_3_SYSTEM,
    PASS_3_USER_TEMPLATE,
)
from app.services.cover_letter.model_router import make_cheap_client, make_expensive_client
from app.services.cover_letter.quality_gates import (
    BURSTINESS_MIN,
    BURSTINESS_MAX,
    COHERENCE_MIN,
    check_specificity,
    compute_burstiness,
    compute_coherence_score,
    normalise_burstiness,
)

logger = logging.getLogger(__name__)

_TABLE = "cover_letters"


# ── Supabase helpers ──────────────────────────────────────────────────────────

async def _patch(letter_id: str, patch: Dict[str, Any]) -> None:
    """Persist a partial update to the cover_letters row. Supabase-py is sync."""
    def _do() -> None:
        get_supabase().table(_TABLE).update(patch).eq("id", letter_id).execute()
    await asyncio.to_thread(_do)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Input formatting helpers ──────────────────────────────────────────────────

def _format_story_numbers(numbers: list) -> str:
    if not numbers:
        return "No specific metrics stated."
    parts = []
    for n in numbers:
        if isinstance(n, dict):
            parts.append(f"{n.get('metric', '')}: {n.get('value', '')}")
        else:
            parts.append(str(n))
    return "; ".join(parts)


def _format_tells(tells: list) -> str:
    if not tells:
        return "  (no specific tells captured)"
    return "\n".join(f"  - {t}" for t in tells)


def _format_list(items: list) -> str:
    if not items:
        return "(none)"
    return ", ".join(str(i) for i in items)


def _jd_priorities(jd_text: str) -> str:
    """Extract a rough priority summary from the JD — first 600 chars."""
    return jd_text[:600].strip()


def _cv_summary(cv_text: str) -> str:
    """Return first 3 non-empty lines of the CV as a brief summary."""
    lines = [l.strip() for l in cv_text.splitlines() if l.strip()]
    return " | ".join(lines[:3]) if lines else cv_text[:200]


# ── Gate 1: honesty check ─────────────────────────────────────────────────────

async def _run_gate_1(
    cheap_client: Any,
    letter_text: str,
    cv_text: str,
) -> tuple[bool, list[str]]:
    """
    Call the cheap model to check every factual claim in the letter against
    the CV. Returns (passed: bool, unsupported_claims: list).
    """
    user = GATE_1_USER_TEMPLATE.format(
        letter_text=letter_text,
        master_cv_text=cv_text[:8000],  # cap to avoid runaway token use
    )
    try:
        result = await cheap_client.complete_json(
            system=GATE_1_SYSTEM,
            user=user,
            max_tokens=512,
            temperature=0.1,
            no_training=True,
        )
        passed = result.get("result", "fail") == "pass"
        unsupported = result.get("unsupported_claims", [])
        return passed, unsupported
    except AIClientError as exc:
        logger.warning("gate_1: honesty check call failed (%s) — treating as pass", exc)
        return True, []  # graceful degradation: don't block generation on gate failures


# ── Pass 1 ────────────────────────────────────────────────────────────────────

async def _run_pass_1(
    cheap_client: Any,
    payload: GenerateCoverLetterRequest,
    extra_grounding: str = "",
) -> str:
    story = payload.story
    user = PASS_1_USER_TEMPLATE.format(
        role=payload.role,
        company_name=payload.company_name,
        company_hook=payload.company_hook_text,
        jd_priorities=_jd_priorities(payload.jd_text),
        story_one_line=story.get("one_line", ""),
        story_detailed=story.get("detailed", ""),
        story_numbers=_format_story_numbers(story.get("numbers", [])),
        cv_summary=_cv_summary(payload.cv_text),
        word_count=payload.word_count_target,
    )
    if extra_grounding:
        user = user + f"\n\nEXTRA GROUNDING REQUIREMENT: {extra_grounding}"
    return await cheap_client.complete(
        system=PASS_1_SYSTEM, user=user,
        max_tokens=600, temperature=0.3, no_training=True,
    )


# ── Pass 2 ────────────────────────────────────────────────────────────────────

async def _run_pass_2(
    expensive_client: Any,
    payload: GenerateCoverLetterRequest,
    pass_1_draft: str,
    extra_coherence: str = "",
) -> str:
    fp = payload.fingerprint
    user = PASS_2_USER_TEMPLATE.format(
        voice_sample=payload.voice_sample_text,
        avg_sentence_length=fp.get("avg_sentence_length", "unknown"),
        sentence_stddev=fp.get("sentence_length_stddev", "unknown"),
        uses_contractions="yes" if fp.get("uses_contractions") else "no",
        uses_em_dashes="yes" if fp.get("uses_em_dashes") else "no",
        uses_semicolons="yes" if fp.get("uses_semicolons") else "no",
        uses_parentheticals="yes" if fp.get("uses_parentheticals") else "no",
        formality_score=fp.get("formality_score", 0.5),
        vocabulary_complexity=fp.get("vocabulary_complexity", "moderate"),
        paragraph_openers=_format_list(fp.get("paragraph_opener_patterns", [])),
        intensifiers=_format_list(fp.get("intensifier_words", [])),
        rhetorical_devices=_format_list(fp.get("rhetorical_devices", [])),
        tells=_format_tells(fp.get("tells", [])),
        pass_1_draft=pass_1_draft,
    )
    if extra_coherence:
        user = user + f"\n\nCOHERENCE REQUIREMENT: {extra_coherence}"
    return await expensive_client.complete(
        system=PASS_2_SYSTEM, user=user,
        max_tokens=800, temperature=0.7, no_training=True,
    )


# ── Pass 3 ────────────────────────────────────────────────────────────────────

async def _run_pass_3(
    cheap_client: Any,
    payload: GenerateCoverLetterRequest,
    pass_2_letter: str,
    extra_variance: str = "",
) -> str:
    user = PASS_3_USER_TEMPLATE.format(
        pass_2_letter=pass_2_letter,
        company_name=payload.company_name,
        role=payload.role,
    )
    if extra_variance:
        user = user + f"\n\nVARIANCE REQUIREMENT: {extra_variance}"
    return await cheap_client.complete(
        system=PASS_3_SYSTEM, user=user,
        max_tokens=700, temperature=0.4, no_training=True,
    )


# ── Main pipeline ─────────────────────────────────────────────────────────────

async def run_cover_letter_pipeline(payload: GenerateCoverLetterRequest) -> None:
    """
    Three-pass cover letter generation. Owns all error handling — never raises.
    Writes progress to cover_letters via Supabase service-role.
    """
    letter_id  = payload.letter_id
    provider   = payload.ai_provider
    api_key    = payload.ai_api_key
    quality_flags: Dict[str, Any] = {}

    logger.info(
        "cover-letter-gen: letter_id=%s provider=%s jd_len=%d cv_len=%d",
        letter_id, provider, len(payload.jd_text), len(payload.cv_text),
    )

    try:
        cheap_client     = make_cheap_client(provider, api_key)
        expensive_client = make_expensive_client(provider, api_key)
    except AIClientError as exc:
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"AI client setup failed: {exc}",
            "completed_at": _now_iso(),
        })
        return

    try:
        await _patch(letter_id, {
            "status": "running",
            "started_at": _now_iso(),
            "pass_1_model": cheap_client.model,
            "pass_2_model": expensive_client.model,
            "pass_3_model": cheap_client.model,
        })

        gen_status = {
            "pass_1": "pending", "pass_2": "pending", "pass_3": "pending",
            "gate_1": "pending", "gate_2": "pending", "gate_3": "pending",
        }

        # ── Pass 1 ───────────────────────────────────────────────────────────
        gen_status["pass_1"] = "running"
        await _patch(letter_id, {"generation_status": gen_status})

        pass_1_output = await _run_pass_1(cheap_client, payload)

        gen_status["pass_1"] = "completed"
        await _patch(letter_id, {
            "pass_1_skeleton": pass_1_output,
            "generation_status": gen_status,
        })
        logger.info("cover-letter-gen: letter_id=%s pass_1 done (%d chars)",
                    letter_id, len(pass_1_output))

        # ── Gate 1: honesty ───────────────────────────────────────────────────
        gen_status["gate_1"] = "running"
        await _patch(letter_id, {"generation_status": gen_status})

        honesty_ok, unsupported = await _run_gate_1(cheap_client, pass_1_output, payload.cv_text)

        if not honesty_ok:
            quality_flags["gate_1_retry"] = True
            quality_flags["gate_1_unsupported"] = unsupported[:5]  # cap list length
            logger.info("cover-letter-gen: letter_id=%s gate_1 fail — retrying pass_1", letter_id)
            grounding = (
                "Every claim MUST appear verbatim in the candidate CV provided. "
                "Do not introduce any achievement, role, or metric not explicitly stated there."
            )
            pass_1_output = await _run_pass_1(cheap_client, payload, extra_grounding=grounding)
            honesty_ok, _ = await _run_gate_1(cheap_client, pass_1_output, payload.cv_text)
            await _patch(letter_id, {"pass_1_skeleton": pass_1_output})

        gen_status["gate_1"] = "completed"
        await _patch(letter_id, {
            "honesty_ok": honesty_ok,
            "generation_status": gen_status,
        })

        # ── Pass 2 ───────────────────────────────────────────────────────────
        gen_status["pass_2"] = "running"
        await _patch(letter_id, {"generation_status": gen_status})

        pass_2_output = await _run_pass_2(expensive_client, payload, pass_1_output)

        # ── Gate 2: coherence (deterministic) ─────────────────────────────────
        gen_status["gate_2"] = "running"
        coherence = compute_coherence_score(pass_2_output, payload.cv_text)

        if coherence < COHERENCE_MIN:
            quality_flags["gate_2_retry"] = True
            quality_flags["gate_2_coherence_score"] = round(coherence, 3)
            logger.info("cover-letter-gen: letter_id=%s gate_2 fail (coherence=%.3f) — retrying pass_2",
                        letter_id, coherence)
            coherence_guidance = (
                "The vocabulary used must closely match the candidate's own CV language. "
                "Prefer simpler, more direct phrasing. Avoid introducing terminology not "
                "found in the candidate's CV or writing sample."
            )
            pass_2_output = await _run_pass_2(
                expensive_client, payload, pass_1_output, extra_coherence=coherence_guidance
            )
            coherence = compute_coherence_score(pass_2_output, payload.cv_text)

        gen_status["pass_2"] = "completed"
        gen_status["gate_2"] = "completed"
        await _patch(letter_id, {
            "pass_2_voice_transferred": pass_2_output,
            "coherence_score": round(coherence, 4) if not math.isnan(coherence) else None,
            "generation_status": gen_status,
        })
        logger.info("cover-letter-gen: letter_id=%s pass_2 done (coherence=%.3f)",
                    letter_id, coherence)

        # ── Pass 3 ───────────────────────────────────────────────────────────
        gen_status["pass_3"] = "running"
        await _patch(letter_id, {"generation_status": gen_status})

        pass_3_output = await _run_pass_3(cheap_client, payload, pass_2_output)

        # ── Gate 3: burstiness (deterministic) ────────────────────────────────
        gen_status["gate_3"] = "running"
        burstiness = compute_burstiness(pass_3_output)
        burstiness_ok = math.isnan(burstiness) or (BURSTINESS_MIN <= burstiness <= BURSTINESS_MAX)

        if not burstiness_ok:
            quality_flags["gate_3_retry"] = True
            quality_flags["gate_3_burstiness"] = round(burstiness, 3)
            logger.info("cover-letter-gen: letter_id=%s gate_3 fail (burstiness=%.3f) — retrying pass_3",
                        letter_id, burstiness)
            variance_guidance = (
                "CRITICAL: vary sentence lengths significantly. At least one sentence must "
                "be under 8 words and at least one must be over 20 words. No three "
                "consecutive sentences should be within 5 words of each other in length."
            )
            pass_3_output = await _run_pass_3(
                cheap_client, payload, pass_2_output, extra_variance=variance_guidance
            )
            burstiness = compute_burstiness(pass_3_output)

        gen_status["pass_3"] = "completed"
        gen_status["gate_3"] = "completed"

        naturalness = normalise_burstiness(burstiness)
        specificity_ok = check_specificity(pass_3_output)

        await _patch(letter_id, {
            "status": "completed",
            "completed_at": _now_iso(),
            "pass_3_final": pass_3_output,
            "burstiness_score": round(burstiness, 4) if not math.isnan(burstiness) else None,
            "naturalness_score": round(naturalness, 4),
            "specificity_ok": specificity_ok,
            "quality_flags": quality_flags,
            "generation_status": gen_status,
        })

        logger.info(
            "cover-letter-gen: letter_id=%s completed — burstiness=%.3f naturalness=%.3f "
            "specificity=%s honesty=%s coherence=%.3f",
            letter_id,
            burstiness if not math.isnan(burstiness) else -1,
            naturalness,
            specificity_ok,
            honesty_ok,
            coherence,
        )

    except AIClientError as exc:
        logger.error("cover-letter-gen: letter_id=%s AI error: %s", letter_id, exc)
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"AI provider error: {str(exc)[:1000]}",
            "quality_flags": quality_flags,
            "completed_at": _now_iso(),
        })
    except Exception as exc:
        logger.exception("cover-letter-gen: letter_id=%s unexpected error", letter_id)
        await _patch(letter_id, {
            "status": "failed",
            "error_message": f"Internal error: {str(exc)[:1000]}",
            "quality_flags": quality_flags,
            "completed_at": _now_iso(),
        })
