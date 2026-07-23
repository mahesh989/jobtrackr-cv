import asyncio

from fastapi import APIRouter

from app.database import get_supabase
from app.db import CV_VERSIONS

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict:
    """Liveness probe — always returns 200 if the process is running."""
    return {"status": "ok"}


@router.get("/health/db")
async def db_health_check() -> dict:
    """Readiness probe — verifies Supabase connectivity."""
    # Lightweight check — confirms service-role key + network path work.
    # supabase-py is sync, so run in a worker thread to keep the loop free.
    await asyncio.to_thread(
        lambda: get_supabase().table(CV_VERSIONS).select("id").limit(1).execute()
    )
    return {"status": "ok", "db": "connected"}
