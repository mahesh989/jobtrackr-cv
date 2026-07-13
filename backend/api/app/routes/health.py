from fastapi import APIRouter

from app.database import get_supabase

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict:
    """Liveness probe — always returns 200 if the process is running."""
    return {"status": "ok"}


@router.get("/health/db")
async def db_health_check() -> dict:
    """Readiness probe — verifies Supabase connectivity."""
    client = get_supabase()
    # Lightweight check — confirms service-role key + network path work.
    client.table("cv_versions").select("id").limit(1).execute()
    return {"status": "ok", "db": "connected"}
