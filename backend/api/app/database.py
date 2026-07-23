from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from supabase import Client, create_client

from app.config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()

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


# ── Supabase client (service role — bypasses RLS, server-side only) ───────────

_supabase_client: Optional[Client] = None


def _force_http1(session: httpx.Client) -> httpx.Client:
    replacement = httpx.Client(
        base_url=session.base_url,
        headers=session.headers,
        timeout=session.timeout,
        follow_redirects=session.follow_redirects,
        http2=False,
    )
    session.close()
    return replacement


def get_supabase() -> Client:
    global _supabase_client
    if _supabase_client is None:
        client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY,
        )
        try:
            client.postgrest.session = _force_http1(client.postgrest.session)
            storage = client.storage
            new_storage_session = _force_http1(storage.session)
            storage.session = new_storage_session
            storage._client = new_storage_session
        except Exception:
            logger.warning(
                "could not force HTTP/1.1 on Supabase sessions — leaving defaults",
                exc_info=True,
            )
        _supabase_client = client
    return _supabase_client


# ── Supabase UPDATE with retry ────────────────────────────────────────────────

_MAX_ATTEMPTS = 4
_BASE_DELAY_S = 0.5


async def supabase_update(
    table:     str,
    row_id:    str | uuid.UUID,
    patch:     dict[str, Any],
    *,
    max_attempts: int = _MAX_ATTEMPTS,
    base_delay_s: float = _BASE_DELAY_S,
) -> None:
    def _do() -> None:
        get_supabase().table(table).update(patch).eq("id", str(row_id)).execute()

    for i in range(max_attempts):
        try:
            await asyncio.to_thread(_do)
            return
        except Exception as exc:
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
    if supabase is None:
        supabase = get_supabase()

    try:
        supabase.storage.from_(bucket).upload(
            path=path,
            file=file,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    except Exception as exc:
        logger.warning("Storage upload failed (%s) — retrying with update()", exc)
        supabase.storage.from_(bucket).update(
            path=path,
            file=file,
            file_options={"content-type": content_type},
        )
