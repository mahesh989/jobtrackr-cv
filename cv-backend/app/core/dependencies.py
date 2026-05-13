from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import parse_clerk_payload
from app.database import get_db
from app.models.user import User
from app.models.user_preference import UserPreference
from app.utils.clerk import fetch_clerk_user, verify_clerk_token

logger = logging.getLogger(__name__)
security = HTTPBearer()


@dataclass
class CurrentUser:
    id: uuid.UUID
    clerk_user_id: str
    email: str
    plan: str


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    """
    FastAPI dependency — verifies Clerk JWT and resolves the internal DB user.

    Auto-provisions a user row if the webhook hasn't fired yet.
    """
    # 1. Verify token
    payload = verify_clerk_token(credentials.credentials)
    clerk_data = parse_clerk_payload(payload)

    if not clerk_data.clerk_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing subject",
        )

    # 2. Look up user in DB
    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_data.clerk_user_id)
    )
    user = result.scalar_one_or_none()

    # 3. Auto-provision if webhook hasn't fired yet
    if user is None:
        # Clerk's default session JWTs don't include email — fall back to REST API
        email = clerk_data.email
        full_name = clerk_data.full_name
        avatar_url = clerk_data.avatar_url
        if not email:
            logger.info(
                "JWT missing email — fetching Clerk user profile for %s",
                clerk_data.clerk_user_id,
            )
            profile = fetch_clerk_user(clerk_data.clerk_user_id)
            if profile and profile.get("email"):
                email = profile["email"]
                full_name = full_name or profile.get("full_name")
                avatar_url = avatar_url or profile.get("avatar_url")

        if not email:
            logger.error(
                "Cannot provision user %s — no email available from JWT or Clerk API",
                clerk_data.clerk_user_id,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User profile incomplete — email required",
            )

        logger.info(
            "Auto-provisioning user for clerk_user_id=%s email=%s",
            clerk_data.clerk_user_id,
            email,
        )
        user = User(
            clerk_user_id=clerk_data.clerk_user_id,
            email=email,
            full_name=full_name,
            avatar_url=avatar_url,
        )
        db.add(user)
        await db.flush()  # get the generated UUID

        # Default preferences
        prefs = UserPreference(user_id=user.id)
        db.add(prefs)
        await db.flush()

        logger.info("Provisioned user id=%s email=%s", user.id, user.email)

    return CurrentUser(
        id=user.id,
        clerk_user_id=user.clerk_user_id,
        email=user.email,
        plan=user.plan,
    )
