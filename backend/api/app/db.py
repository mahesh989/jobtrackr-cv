"""
Shared DB helpers — retry-safe Supabase writes, storage upload, table constants.

Thin wrappers only: no models, no sessions, no in-memory caching. Every
function is safe to call from an async context (supabase-py is sync; we
run in asyncio.to_thread).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# ── Table name constants ──────────────────────────────────────────────────────

ANALYSIS_RUNS = "analysis_runs"
COVER_LETTERS = "cover_letters"
AI_CALLS      = "ai_calls"
CV_VERSIONS   = "cv_versions"
VOICE_PROFILES         = "voice_profiles"
STORIES                = "stories"
COMPANY_RESEARCH_FACTS = "company_research_facts"


# ── Timestamp ─────────────────────────────────────────────────────────────────

def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Supabase UPDATE with retry ────────────────────────────────────────────────

_MAX_ATTEMPTS = 4
_BASE_DELAY_S = 0.5   # backoff doubles: 0.5s, 1s, 2s, 4s


async def supabase_update(
    table:     str,
    row_id:    str | uuid.UUID,
    patch:     dict[str, Any],
    *,
    max_attempts: int = _MAX_ATTEMPTS,
    base_delay_s: float = _BASE_DELAY_S,
) -> None:
    """UPDATE a single row via Supabase REST. Retries on transient failures,
    NEVER raises. A status/progress write must not crash a pipeline whose
    real work already succeeded.
    """
    def _do() -> None:
        from app.database import get_supabase
        get_supabase().table(table).update(patch).eq("id", str(row_id)).execute()

    for i in range(max_attempts):
        try:
            await asyncio.to_thread(_do)
            return
        except Exception as exc:  # noqa: BLE001
            if i < max_attempts - 1:
                await asyncio.sleep(base_delay_s * (2 ** i))
                continue
            logger.warning(
                "supabase_update(%s, %s): failed after %d attempts (%s) — continuing",
                table, row_id, max_attempts, exc,
            )


# ── Storage upload (upload → fallback to update) ──────────────────────────────

def upload_or_update(
    bucket:       str,
    path:         str,
    file:         bytes,
    content_type: str,
    *,
    supabase:     Any = None,
) -> None:
    """Upload a file to Supabase Storage. If the object already exists,
    retry as update. Runs synchronously — caller must wrap in to_thread.

    Pass supabase when calling from a sync context (e.g. inside
    asyncio.to_thread) to avoid re-importing get_supabase.
    """
    if supabase is None:
        from app.database import get_supabase
        supabase = get_supabase()

    try:
        supabase.storage.from_(bucket).upload(
            path=path,
            file=file,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    except Exception as exc:
        # Object may exist from a previous run — retry as update.
        logger.warning("Storage upload failed (%s) — retrying with update()", exc)
        supabase.storage.from_(bucket).update(
            path=path,
            file=file,
            file_options={"content-type": content_type},
        )
