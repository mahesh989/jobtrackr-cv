from fastapi import APIRouter
from sqlalchemy import text

from app.database import AsyncSessionLocal

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict:
    """Liveness probe — always returns 200 if the process is running."""
    return {"status": "ok"}


@router.get("/health/db")
async def db_health_check() -> dict:
    """Readiness probe — verifies DB connectivity."""
    async with AsyncSessionLocal() as session:
        await session.execute(text("SELECT 1"))
    return {"status": "ok", "db": "connected"}
