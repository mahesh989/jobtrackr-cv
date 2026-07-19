"""
Auto-generate a cover letter at the end of an analysis run.

Called from the orchestrator (AWAITED, not detached) when the tailored
ATS score clears min_final_ats. Writes its outcome to
analysis_runs.cover_letter_status on EVERY return path so the UI can
surface 'triggered / skipped:<why> / failed:<why>' instead of mystery
silence.

Design notes:
  - Idempotency is self-healing: stuck pending/running/picking rows older
    than STUCK_LETTER_AGE_MIN minutes are auto-retired so they can't
    permanently block regeneration.
  - The cover_letters INSERT must match the schema. We assert at module
    import time that the chosen initial status is in the CHECK set —
    catches future regressions before any user-visible failure.
  - All AI/DB calls are wrapped in narrow exception handlers; outcomes
    are recorded on the analysis_run row regardless of where the failure
    happens.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from postgrest.exceptions import APIError

from app.database import get_supabase
from app.enums import CoverLetterStatus
from app.schemas.cover_letter import GenerateCoverLetterRequest
from app.services.cover_letter.generator import run_cover_letter_pipeline

logger = logging.getLogger(__name__)

_COVER_LETTERS  = "cover_letters"
_ANALYSIS_RUNS  = "analysis_runs"

_ALLOWED_STATUSES   = frozenset(CoverLetterStatus)
_INITIAL_STATUS     = CoverLetterStatus.PENDING

# Module-load-time assertion so a future regression (e.g. someone changing
# _INITIAL_STATUS to a value not in the constraint) fails fast at import,
# not silently on every analysis run.
assert _INITIAL_STATUS in _ALLOWED_STATUSES, (
    f"bug: _INITIAL_STATUS={_INITIAL_STATUS!r} is not in cover_letters CHECK set "
    f"{sorted(_ALLOWED_STATUSES)}. Update one or the other."
)

# Cover-letter pipeline runs are typically < 60s. Anything older than this
# is dead — auto-retire so it stops blocking new attempts.
STUCK_LETTER_AGE_MIN = 15

# Status values that block regeneration when RECENT (within
# STUCK_LETTER_AGE_MIN minutes). Older rows in these states are treated
# as dead and auto-stale-d.
_BLOCKING_IF_RECENT = frozenset({CoverLetterStatus.PENDING, CoverLetterStatus.RUNNING, CoverLetterStatus.PICKING})


def _make_slug(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:80].rstrip("_") or "unknown_company"


def _record_outcome(run_id: str, outcome: str) -> None:
    """Persist the auto-cover-letter outcome to analysis_runs.cover_letter_status.

    Best-effort — must not raise. Used from every code path in
    auto_generate_cover_letter so the UI can always tell what happened.
    """
    if len(outcome) > 200:  # text column is unbounded but keep it tidy
        outcome = outcome[:200]
    try:
        get_supabase().table(_ANALYSIS_RUNS).update(
            {"cover_letter_status": outcome}
        ).eq("id", run_id).execute()
    except Exception as exc:  # noqa: BLE001  — best effort, never re-raise
        logger.warning("auto-cover-letter: could not record outcome %r on run %s: %s",
                       outcome, run_id, exc)


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # PostgREST returns ISO strings with 'Z' or '+00:00'
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


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
    Attempt to auto-generate a cover letter for a successful analysis run.
    Always records outcome to analysis_runs.cover_letter_status; never
    raises. Safe to await directly from the orchestrator.
    """
    sb = get_supabase()

    try:
        # ── 1. Resolve job_id from the analysis run ──────────────────────────
        try:
            run_row = (
                sb.table(_ANALYSIS_RUNS).select("job_id").eq("id", run_id).single().execute()
            )
        except APIError as exc:
            logger.warning("auto-cover-letter: run %s lookup failed: %s", run_id, exc)
            _record_outcome(run_id, f"failed:run_lookup:{exc.code or '?'}")
            return
        if not run_row.data:
            logger.warning("auto-cover-letter: run %s not found", run_id)
            _record_outcome(run_id, "failed:run_not_found")
            return
        job_id: str = run_row.data["job_id"]

        # ── 2. Idempotency w/ self-heal ──────────────────────────────────────
        # A 'completed' letter always blocks regeneration. A 'failed' or
        # OLD 'pending'/'running'/'picking' letter gets auto-retired so it
        # can't permanently block.
        existing = (
            sb.table(_COVER_LETTERS)
            .select("id, status, created_at")
            .eq("job_id", job_id)
            .eq("user_id", user_id)
            .eq("is_stale", False)
            .execute()
        )

        cutoff = datetime.now(timezone.utc) - timedelta(minutes=STUCK_LETTER_AGE_MIN)
        truly_blocking: list[Dict[str, Any]] = []
        to_retire:      list[Dict[str, Any]] = []
        for r in (existing.data or []):
            status   = r.get("status")
            created  = _parse_ts(r.get("created_at"))
            if status == CoverLetterStatus.COMPLETED:
                to_retire.append(r)
            elif status == CoverLetterStatus.FAILED:
                to_retire.append(r)
            elif status in _BLOCKING_IF_RECENT:
                if created is not None and created < cutoff:
                    to_retire.append(r)   # stuck — retire and proceed
                else:
                    truly_blocking.append(r)  # recent, probably in flight
            else:
                # Unknown status — be conservative, treat as blocking
                truly_blocking.append(r)

        if truly_blocking:
            logger.info(
                "auto-cover-letter: job %s — a non-stale letter is already active "
                "(status=%s) — skipping",
                job_id, [r.get("status") for r in truly_blocking],
            )
            _record_outcome(run_id, "skipped:duplicate")
            return

        for r in to_retire:
            try:
                sb.table(_COVER_LETTERS).update({"is_stale": True}).eq("id", r["id"]).execute()
                logger.info(
                    "auto-cover-letter: job %s — retired stale letter %s (status=%s)",
                    job_id, r["id"], r.get("status"),
                )
            except APIError as exc:
                logger.warning("auto-cover-letter: could not retire stale letter %s: %s", r["id"], exc)
                # Not fatal — even if retire fails, the new INSERT might still succeed.

        # ── 3. Voice profile ─────────────────────────────────────────────────
        try:
            voice_row = (
                sb.table("voice_profiles")
                .select("fingerprint, voice_sample_raw")
                .eq("user_id", user_id).limit(1).execute()
            )
        except APIError as exc:
            logger.warning("auto-cover-letter: voice fetch failed: %s", exc)
            _record_outcome(run_id, f"failed:voice_fetch:{exc.code or '?'}")
            return
        if not voice_row.data:
            logger.info("auto-cover-letter: job %s — no voice profile, skipping", job_id)
            _record_outcome(run_id, "skipped:no_voice")
            return
        voice = voice_row.data[0]
        if not voice.get("fingerprint") or not voice.get("voice_sample_raw"):
            logger.info("auto-cover-letter: job %s — incomplete voice profile, skipping", job_id)
            _record_outcome(run_id, "skipped:no_voice")
            return

        # ── 4. Story ─────────────────────────────────────────────────────────
        try:
            story_row = (
                sb.table("stories")
                .select("id, title, domain, year, one_line, detailed, numbers, tags")
                .eq("user_id", user_id)
                .order("extraction_timestamp", desc=True)
                .limit(1).execute()
            )
        except APIError as exc:
            logger.warning("auto-cover-letter: stories fetch failed: %s", exc)
            _record_outcome(run_id, f"failed:stories_fetch:{exc.code or '?'}")
            return
        # No stories is NOT a blocker — the generator handles story=None
        # (format_story renders "(none available)"; the letter draws its
        # substance from the CV text). Duty-based CVs (care/trades) often
        # yield zero metric-backed stories; their letters must still generate.
        story: Optional[Dict[str, Any]] = story_row.data[0] if story_row.data else None
        if story is None:
            logger.info("auto-cover-letter: job %s — no stories, generating without one", job_id)

        # ── 5. Company hook (best available, generic fallback) ───────────────
        company_hook = (
            f"I've followed {company_name}'s work closely and am genuinely "
            "excited about this opportunity."
        )
        try:
            hook_row = (
                sb.table("company_research_facts")
                .select("hook_text")
                .eq("company_slug", _make_slug(company_name))
                .limit(1).execute()
            )
            if hook_row.data and hook_row.data[0].get("hook_text"):
                company_hook = hook_row.data[0]["hook_text"]
        except APIError as exc:
            logger.info("auto-cover-letter: company hook fetch failed (using fallback): %s", exc)
            # Generic fallback is fine, not fatal.

        # ── 6. INSERT cover_letters row ──────────────────────────────────────
        # Defensive: re-assert the status value before hitting Postgres.
        # The module-level assertion already proved this true at import; this
        # is a final belt-and-braces check in case someone refactors the
        # status name into a variable without updating the constraint set.
        if _INITIAL_STATUS not in _ALLOWED_STATUSES:
            logger.error(
                "auto-cover-letter: refusing to INSERT — status %r not in CHECK set %s",
                _INITIAL_STATUS, sorted(_ALLOWED_STATUSES),
            )
            _record_outcome(run_id, f"failed:bad_status_constant:{_INITIAL_STATUS}")
            return

        letter_id = str(uuid.uuid4())
        try:
            sb.table(_COVER_LETTERS).insert({
                "id":              letter_id,
                "user_id":         user_id,
                "job_id":          job_id,
                "analysis_run_id": run_id,
                "status":          _INITIAL_STATUS,
                "is_stale":        False,
                "ai_provider":     ai_provider,
            }).execute()
        except APIError as exc:
            # Most likely cause now: schema drift (unknown column, missing
            # NOT NULL, FK violation). Surface the Postgres code so the UI
            # error is diagnostically useful.
            logger.error(
                "auto-cover-letter: INSERT failed for run %s job %s: code=%s msg=%s",
                run_id, job_id, exc.code, exc.message,
            )
            _record_outcome(run_id, f"failed:insert:{exc.code or '?'}")
            return

        # ── 7. Kick off the generator pipeline ───────────────────────────────
        payload = GenerateCoverLetterRequest(
            letter_id=         letter_id,
            user_id=           user_id,
            job_id=            job_id,
            jd_text=           jd_text,
            role=              job_title or "the role",
            company_name=      company_name or "the company",
            cv_text=           cv_text,
            voice_sample_text= voice["voice_sample_raw"],
            fingerprint=       voice["fingerprint"],
            story=             story,
            company_hook_text= company_hook,
            tone_target=       "professional",
            ai_provider=       ai_provider,  # type: ignore[arg-type]
            ai_api_key=        ai_api_key,
            ai_model=          ai_model,
        )

        # The 3-pass generation itself is genuinely long-running (~30-60s)
        # so we DO fire it as a background task — but only AFTER the INSERT
        # succeeded and outcome is recorded. If this process restarts before
        # the generator finishes, the row is in 'running' state and the
        # self-healing idempotency above will retire it after 15 min.
        asyncio.create_task(run_cover_letter_pipeline(payload))

        _record_outcome(run_id, "triggered")
        logger.info(
            "auto-cover-letter: job %s — letter %s triggered (run %s)",
            job_id, letter_id, run_id,
        )

    except Exception as exc:  # noqa: BLE001 — last-resort safety net
        logger.exception("auto-cover-letter: unhandled error for run %s: %s", run_id, exc)
        _record_outcome(run_id, f"failed:unhandled:{type(exc).__name__}")
