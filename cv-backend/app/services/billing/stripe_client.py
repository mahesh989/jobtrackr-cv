"""
Thin Stripe SDK wrapper.

We isolate Stripe calls here so:
  - The route handlers stay focused on auth / DB work
  - Tests can mock this module without monkey-patching the SDK directly
  - We can swap the wire format (checkout vs. payment links etc.) in one place
"""
from __future__ import annotations

import logging
from typing import Optional

import stripe

from app.config import get_settings

logger = logging.getLogger(__name__)


def _client() -> "stripe":  # type: ignore[name-defined]
    """Configure the Stripe SDK lazily — keeps import-time clean for tests."""
    settings = get_settings()
    if not settings.STRIPE_SECRET_KEY:
        raise RuntimeError("STRIPE_SECRET_KEY is not configured")
    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


def is_configured() -> bool:
    settings = get_settings()
    return bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_PRO_PRICE_ID)


async def get_or_create_customer(
    *,
    user_id: str,
    email: str,
    full_name: Optional[str],
    existing_stripe_customer_id: Optional[str],
) -> str:
    """Return a Stripe customer id. Reuses the saved one if present."""
    s = _client()
    if existing_stripe_customer_id:
        try:
            customer = s.Customer.retrieve(existing_stripe_customer_id)
            if not getattr(customer, "deleted", False):
                return existing_stripe_customer_id
        except stripe.error.InvalidRequestError:
            # Fall through and create a fresh one
            logger.info("Stripe customer %s gone — recreating", existing_stripe_customer_id)

    customer = s.Customer.create(
        email=email,
        name=full_name or None,
        metadata={"app_user_id": user_id},
    )
    return customer["id"]


async def create_checkout_session(
    *,
    customer_id: str,
    price_id: str,
    success_url: str,
    cancel_url: str,
    user_id: str,
) -> str:
    """Create a subscription checkout session and return its URL."""
    s = _client()
    session = s.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        client_reference_id=user_id,
        allow_promotion_codes=True,
        billing_address_collection="auto",
        metadata={"app_user_id": user_id},
        subscription_data={"metadata": {"app_user_id": user_id}},
    )
    return session["url"]


async def create_portal_session(
    *,
    customer_id: str,
    return_url: str,
) -> str:
    """Create a Customer Portal session for managing subscriptions."""
    s = _client()
    session = s.billing_portal.Session.create(
        customer=customer_id,
        return_url=return_url,
    )
    return session["url"]


def construct_event(payload: bytes, signature: str, secret: str):
    """Verify webhook signature and parse the event."""
    return stripe.Webhook.construct_event(payload, signature, secret)
