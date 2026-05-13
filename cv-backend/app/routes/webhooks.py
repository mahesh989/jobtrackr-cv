"""
Clerk webhook handler.

Clerk sends signed events when users are created/updated/deleted.
We use svix to verify the signature, then upsert our local User row.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from svix.webhooks import Webhook, WebhookVerificationError

from app.config import get_settings
from app.database import get_db
from app.models.user import User
from app.models.user_preference import UserPreference

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])


async def _get_or_create_user(
    db: AsyncSession,
    clerk_user_id: str,
    email: str,
    full_name: Optional[str],
    avatar_url: Optional[str],
) -> User:
    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_user_id)
    )
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            clerk_user_id=clerk_user_id,
            email=email,
            full_name=full_name,
            avatar_url=avatar_url,
        )
        db.add(user)
        await db.flush()  # get the generated id

        # Create default preferences
        pref = UserPreference(user_id=user.id)
        db.add(pref)
        logger.info("Provisioned new user from webhook", extra={"clerk_id": clerk_user_id})
    else:
        # Update mutable fields
        user.email = email
        if full_name is not None:
            user.full_name = full_name
        if avatar_url is not None:
            user.avatar_url = avatar_url
        logger.info("Updated user from webhook", extra={"clerk_id": clerk_user_id})
    return user


@router.post("/clerk", status_code=status.HTTP_200_OK)
async def clerk_webhook(
    request: Request,
    svix_id: str = Header(..., alias="svix-id"),
    svix_timestamp: str = Header(..., alias="svix-timestamp"),
    svix_signature: str = Header(..., alias="svix-signature"),
    db: AsyncSession = Depends(get_db),
) -> None:
    settings = get_settings()
    secret = settings.webhook_secret

    payload = await request.body()
    headers = {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
    }

    try:
        wh = Webhook(secret)
        event = wh.verify(payload, headers)
    except WebhookVerificationError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid webhook signature")

    event_type: str = event.get("type", "")
    data: dict = event.get("data", {})

    if event_type in ("user.created", "user.updated"):
        clerk_user_id: str = data["id"]
        # Primary email is the first verified email address
        email_addresses: list = data.get("email_addresses", [])
        primary_email_id: Optional[str] = data.get("primary_email_address_id")
        email = ""
        for ea in email_addresses:
            if ea.get("id") == primary_email_id:
                email = ea.get("email_address", "")
                break
        if not email and email_addresses:
            email = email_addresses[0].get("email_address", "")

        first = data.get("first_name") or ""
        last = data.get("last_name") or ""
        full_name = f"{first} {last}".strip() or None
        avatar_url = data.get("image_url") or data.get("profile_image_url")

        await _get_or_create_user(
            db, clerk_user_id, email, full_name, avatar_url
        )
        await db.commit()

    elif event_type == "user.deleted":
        clerk_user_id = data.get("id", "")
        result = await db.execute(
            select(User).where(User.clerk_user_id == clerk_user_id)
        )
        user = result.scalar_one_or_none()
        if user:
            await db.delete(user)
            await db.commit()
            logger.info("Deleted user from webhook", extra={"clerk_id": clerk_user_id})
    else:
        # Unhandled event type — acknowledge but do nothing
        logger.debug("Unhandled Clerk webhook event", extra={"type": event_type})
