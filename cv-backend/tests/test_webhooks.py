"""
Tests for the Clerk webhook endpoint.

Uses a patched Webhook.verify so we don't need a real svix secret.
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.user_preference import UserPreference


def _webhook_headers(event_type: str = "user.created") -> dict:
    return {
        "svix-id": "test-svix-id",
        "svix-timestamp": "1234567890",
        "svix-signature": "v1,test-sig",
    }


def _user_created_payload(clerk_id: str, email: str) -> dict:
    return {
        "type": "user.created",
        "data": {
            "id": clerk_id,
            "primary_email_address_id": "eid_1",
            "email_addresses": [{"id": "eid_1", "email_address": email}],
            "first_name": "Test",
            "last_name": "User",
            "image_url": None,
        },
    }


@pytest.mark.asyncio
async def test_webhook_user_created(client: AsyncClient, db_session: AsyncSession) -> None:
    clerk_id = f"user_{uuid.uuid4().hex}"
    email = f"test_{uuid.uuid4().hex}@example.com"
    payload = _user_created_payload(clerk_id, email)

    with patch("app.routes.webhooks.Webhook") as mock_wh_cls:
        mock_wh = MagicMock()
        mock_wh.verify.return_value = payload
        mock_wh_cls.return_value = mock_wh

        response = await client.post(
            "/api/v1/webhooks/clerk",
            content=json.dumps(payload),
            headers=_webhook_headers(),
        )

    assert response.status_code == 204

    # Verify user was created in DB
    result = await db_session.execute(select(User).where(User.clerk_user_id == clerk_id))
    user = result.scalar_one_or_none()
    assert user is not None
    assert user.email == email
    assert user.full_name == "Test User"

    # Verify preferences were created
    pref_result = await db_session.execute(
        select(UserPreference).where(UserPreference.user_id == user.id)
    )
    pref = pref_result.scalar_one_or_none()
    assert pref is not None
    assert pref.ai_provider == "anthropic"


@pytest.mark.asyncio
async def test_webhook_user_deleted(client: AsyncClient, db_session: AsyncSession) -> None:
    # First create a user
    clerk_id = f"user_{uuid.uuid4().hex}"
    user = User(
        clerk_user_id=clerk_id,
        email=f"del_{uuid.uuid4().hex}@example.com",
    )
    db_session.add(user)
    await db_session.commit()

    delete_payload = {"type": "user.deleted", "data": {"id": clerk_id}}

    with patch("app.routes.webhooks.Webhook") as mock_wh_cls:
        mock_wh = MagicMock()
        mock_wh.verify.return_value = delete_payload
        mock_wh_cls.return_value = mock_wh

        response = await client.post(
            "/api/v1/webhooks/clerk",
            content=json.dumps(delete_payload),
            headers=_webhook_headers("user.deleted"),
        )

    assert response.status_code == 204

    result = await db_session.execute(select(User).where(User.clerk_user_id == clerk_id))
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_webhook_invalid_signature(client: AsyncClient) -> None:
    from svix.webhooks import WebhookVerificationError

    with patch("app.routes.webhooks.Webhook") as mock_wh_cls:
        mock_wh = MagicMock()
        mock_wh.verify.side_effect = WebhookVerificationError("bad sig")
        mock_wh_cls.return_value = mock_wh

        response = await client.post(
            "/api/v1/webhooks/clerk",
            content=b"{}",
            headers=_webhook_headers(),
        )

    assert response.status_code == 400
