from __future__ import annotations

import logging
from typing import AsyncGenerator, Optional

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from supabase import Client, create_client

from app.config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()

# ---------------------------------------------------------------------------
# SQLAlchemy async engine
# ---------------------------------------------------------------------------
engine = create_async_engine(
    settings.SUPABASE_DB_URL,
    echo=settings.ENVIRONMENT == "development",
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ---------------------------------------------------------------------------
# Supabase client (service role — bypasses RLS, server-side only)
# ---------------------------------------------------------------------------
_supabase_client: Optional[Client] = None


def _force_http1(session: httpx.Client) -> httpx.Client:
    """Rebuild a Supabase sub-client's httpx session as HTTP/1.1.

    postgrest-py and storage3 hard-code ``http2=True`` on their httpx clients,
    and our service-role client is a long-lived singleton — so its shared
    HTTP/2 connection accumulates hundreds of streams until Supabase's edge
    sends a GOAWAY. That surfaced mid-pipeline as an unhandled
    ``<ConnectionTerminated error_code:1, last_stream_id:…>`` and failed the
    analysis run with a generic "Internal error". HTTP/1.1 has no stream
    multiplexing, so the entire GOAWAY class disappears; httpx still keep-alives
    and transparently reconnects per request. The replacement preserves the
    original base_url, auth headers, timeout and redirect policy.
    """
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
    """Returns a singleton Supabase service-role client."""
    global _supabase_client
    if _supabase_client is None:
        client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY,
        )
        # Force the shared postgrest (DB) + storage sessions onto HTTP/1.1 to
        # avoid HTTP/2 GOAWAY / ConnectionTerminated failures on the long-lived
        # singleton connection (see _force_http1). Hardening only — never let it
        # block client init.
        try:
            client.postgrest.session = _force_http1(client.postgrest.session)
            storage = client.storage
            new_storage_session = _force_http1(storage.session)
            storage.session = new_storage_session
            storage._client = new_storage_session
        except Exception:  # noqa: BLE001 — degrade to default (HTTP/2) client
            logger.warning(
                "could not force HTTP/1.1 on Supabase sessions — leaving defaults",
                exc_info=True,
            )
        _supabase_client = client
    return _supabase_client
