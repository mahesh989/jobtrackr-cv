"""
Pytest configuration and shared fixtures.

Uses an in-memory SQLite database (via aiosqlite) for fast, isolated tests
that do not require a running Postgres/Supabase instance.
"""
from __future__ import annotations

import uuid
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base, get_db
from app.models import *  # noqa: F401,F403 — ensure all tables are registered

# ---------------------------------------------------------------------------
# In-memory SQLite engine for tests
# ---------------------------------------------------------------------------

TEST_DATABASE_URL = "sqlite+aiosqlite://"


@pytest_asyncio.fixture(scope="function")
async def db_engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture(scope="function")
async def db_session(db_engine) -> AsyncGenerator[AsyncSession, None]:
    Session = async_sessionmaker(bind=db_engine, expire_on_commit=False)
    async with Session() as session:
        yield session


# ---------------------------------------------------------------------------
# FastAPI test client with DB override
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="function")
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    from app.main import app

    async def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db

    # Patch get_settings to provide test values
    mock_settings = MagicMock()
    mock_settings.ALLOWED_ORIGINS = ["*"]
    mock_settings.ENVIRONMENT = "test"
    mock_settings.SENTRY_DSN = ""
    mock_settings.SUPABASE_CV_BUCKET = "cv-files"
    mock_settings.webhook_secret = "test-secret"

    with patch("app.config.get_settings", return_value=mock_settings):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            yield ac

    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Helper factories
# ---------------------------------------------------------------------------


def make_user_id() -> uuid.UUID:
    return uuid.uuid4()
