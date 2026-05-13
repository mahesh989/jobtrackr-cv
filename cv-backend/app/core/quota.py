from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User

FREE_TIER_LIMIT = 100


async def check_quota(user_id: uuid.UUID, db: AsyncSession) -> None:
    """
    Check whether the user has exceeded their monthly analysis quota.
    Resets the counter if quota_reset_at has passed.
    Raises HTTP 402 if free-tier limit is reached.
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    now = datetime.now(timezone.utc)

    # Reset quota if the reset window has passed
    if user.quota_reset_at <= now:
        from dateutil.relativedelta import relativedelta  # type: ignore

        next_reset = (now + relativedelta(months=1)).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        await db.execute(
            update(User)
            .where(User.id == user_id)
            .values(analyses_used_this_month=0, quota_reset_at=next_reset)
        )
        await db.flush()
        # Refresh local object
        await db.refresh(user)

    if user.plan == "free" and user.analyses_used_this_month >= FREE_TIER_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "error": "quota_exceeded",
                "limit": FREE_TIER_LIMIT,
                "used": user.analyses_used_this_month,
                "message": "Upgrade to Pro for unlimited analyses",
            },
        )


async def increment_quota(user_id: uuid.UUID, db: AsyncSession) -> None:
    """Atomically increment the monthly analysis counter for the user."""
    await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(analyses_used_this_month=User.analyses_used_this_month + 1)
    )
    await db.flush()
