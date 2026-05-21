"""
Phase E-2 — Auto-generate a cover letter after a passing automation run.

Called from the orchestrator as an asyncio background task when:
  - payload.automation is True
  - passed_final_gate is True (tailored score >= min_final_ats)

Mirrors the web /api/jobs/[id]/cover-letter route but runs entirely inside
cv-backend, using:
  - Supabase service-role for all DB reads
  - The existing run_cover_letter_pipeline function
  - The most recent story (no match API call — automation uses best available)
  - First available company hook, or generic fallback
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any, Dict, Optional

from app.database import get_supabase
from app.schemas.cover_letter import GenerateCoverLetterRequest
from app.services.cover_letter.generator import run_cover_letter_pipeline

logger = logging.getLogger(__name__)

_COVER_LETTERS = "cover_letters"


def _make_slug(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:80].rstrip("_") or "unknown_company"


async def auto_generate_cover_letter(
    run_id:       str,
    user_id:      str,
    jd_text:      str,
    job_title:    str,
    company_name: str,
    cv_text:      str,
    ai_provider:  str,
    ai_api_key:   str,
    ai_model:     Optional[str],
) -> None:
    """
    Attempt to auto-generate a cover letter after a passing automation analysis.
    All failures are logged and silently swallowed — auto cover letter is
    best-effort and must never block or crash the main orchestrator.
    """
    sb = get_supabase()

    try:
        # ── 1. Look up job_id from the analysis_run ───────────────────────────
        run_row = (
            sb.table("analysis_runs")
            .select("job_id")
            .eq("id", run_id)
            .single()
            .execute()
        )
        if not run_row.data:
            logger.warning("auto-cover-letter: run %s not found — skipping", run_id)
            return
        job_id: str = run_row.data["job_id"]

        # ── 2. Idempotency check ──────────────────────────────────────────────
        existing = (
            sb.table(_COVER_LETTERS)
            .select("id")
            .eq("job_id", job_id)
            .eq("user_id", user_id)
            .eq("is_stale", False)
            .limit(1)
            .execute()
        )
        if existing.data:
            logger.info("auto-cover-letter: job %s already has a letter — skipping", job_id)
            return

        # ── 3. Fetch voice profile ────────────────────────────────────────────
        voice_row = (
            sb.table("voice_profiles")
            .select("fingerprint, voice_sample_raw")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if not voice_row.data:
            logger.warning("auto-cover-letter: job %s — no voice profile, skipping", job_id)
            return
        voice = voice_row.data[0]
        if not voice.get("fingerprint") or not voice.get("voice_sample_raw"):
            logger.warning("auto-cover-letter: job %s — incomplete voice profile, skipping", job_id)
            return

        # ── 4. Pick most recent story ─────────────────────────────────────────
        story_row = (
            sb.table("stories")
            .select("id, title, domain, year, one_line, detailed, numbers, tags")
            .eq("user_id", user_id)
            .order("extraction_timestamp", desc=True)
            .limit(1)
            .execute()
        )
        if not story_row.data:
            logger.warning("auto-cover-letter: job %s — no stories, skipping", job_id)
            return
        story: Dict[str, Any] = story_row.data[0]

        # ── 5. Company hook (best available, generic fallback) ────────────────
        company_hook = f"I've followed {company_name}'s work closely and am genuinely excited about this opportunity."
        try:
            hook_row = (
                sb.table("company_research_facts")
                .select("hook_text")
                .eq("company_slug", _make_slug(company_name))
                .limit(1)
                .execute()
            )
            if hook_row.data and hook_row.data[0].get("hook_text"):
                company_hook = hook_row.data[0]["hook_text"]
        except Exception:
            pass  # generic fallback is fine

        # ── 6. Create cover_letters row ───────────────────────────────────────
        letter_id = str(uuid.uuid4())
        sb.table(_COVER_LETTERS).insert({
            "id":              letter_id,
            "user_id":         user_id,
            "job_id":          job_id,
            "analysis_run_id": run_id,
            "status":          "generating",
            "is_stale":        False,
        }).execute()

        # ── 7. Build payload and run pipeline ─────────────────────────────────
        payload = GenerateCoverLetterRequest(
            letter_id=          letter_id,
            user_id=            user_id,
            job_id=             job_id,
            jd_text=            jd_text,
            role=               job_title or "the role",
            company_name=       company_name or "the company",
            cv_text=            cv_text,
            voice_sample_text=  voice["voice_sample_raw"],
            fingerprint=        voice["fingerprint"],
            story=              story,
            company_hook_text=  company_hook,
            tone_target=        "professional",
            ai_provider=        ai_provider,   # type: ignore[arg-type]
            ai_api_key=         ai_api_key,
            ai_model=           ai_model,
        )

        asyncio.create_task(run_cover_letter_pipeline(payload))
        logger.info(
            "auto-cover-letter: job %s — letter %s triggered (run %s)",
            job_id, letter_id, run_id,
        )

    except Exception as exc:
        logger.exception("auto-cover-letter: job for run %s failed: %s", run_id, exc)
