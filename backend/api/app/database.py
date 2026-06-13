from __future__ import annotations

import logging
from typing import AsyncGenerator, Optional

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


def get_supabase() -> Client:
    """Returns a singleton Supabase service-role client."""
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY,
        )
    return _supabase_client
