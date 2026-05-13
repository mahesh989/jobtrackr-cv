"""
Stripe billing endpoints.

  POST /billing/checkout       Create a checkout session, return its URL
  POST /billing/portal         Create a customer-portal session, return its URL
  POST /billing/webhook        Receive Stripe events (signature-verified)
  GET  /billing/config         Public config (publishable key + price id) for FE

Webhook events handled:
  - checkout.session.completed     → mark plan='pro', save sub id
  - customer.subscription.updated  → reconcile plan based on status
  - customer.subscription.deleted  → mark plan='free'
"""
from __future__ import annotations

import logging
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.dependencies import CurrentUser, get_current_user
from app.database import get_db
from app.models.user import User
from app.services.billing import stripe_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/billing", tags=["billing"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CheckoutResponse(BaseModel):
    url: str


class PortalResponse(BaseModel):
    url: str


class BillingConfigResponse(BaseModel):
    publishable_key: str
    pro_price_id: str
    configured: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ensure_configured() -> None:
    if not stripe_client.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Billing is not configured on this server",
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/config", response_model=BillingConfigResponse)
async def get_billing_config() -> BillingConfigResponse:
    """Expose non-secret billing config to the frontend (no auth needed)."""
    settings = get_settings()
    return BillingConfigResponse(
        publishable_key=settings.STRIPE_PUBLISHABLE_KEY,
        pro_price_id=settings.STRIPE_PRO_PRICE_ID,
        configured=stripe_client.is_configured(),
    )


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CheckoutResponse:
    """Start a Stripe Checkout for the Pro plan and return the redirect URL."""
    _ensure_configured()
    settings = get_settings()

    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one()

    if user.plan == "pro":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You're already on the Pro plan",
        )

    customer_id = await stripe_client.get_or_create_customer(
        user_id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        existing_stripe_customer_id=user.stripe_customer_id,
    )
    if user.stripe_customer_id != customer_id:
        user.stripe_customer_id = customer_id
        await db.commit()

    base = settings.APP_URL.rstrip("/")
    success_url = (
        f"{base}{settings.STRIPE_BILLING_SUCCESS_PATH}"
        "?session_id={CHECKOUT_SESSION_ID}"
    )
    cancel_url = f"{base}{settings.STRIPE_BILLING_CANCEL_PATH}"

    try:
        url = await stripe_client.create_checkout_session(
            customer_id=customer_id,
            price_id=settings.STRIPE_PRO_PRICE_ID,
            success_url=success_url,
            cancel_url=cancel_url,
            user_id=str(user.id),
        )
    except stripe.error.StripeError as e:
        logger.exception("Stripe checkout creation failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Stripe error: {e.user_message or str(e)}",
        )

    return CheckoutResponse(url=url)


@router.post("/portal", response_model=PortalResponse)
async def create_portal(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PortalResponse:
    """Open the Stripe Customer Portal for the user to manage their subscription."""
    _ensure_configured()
    settings = get_settings()

    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one()

    if not user.stripe_customer_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No Stripe customer for this user — start a subscription first",
        )

    return_url = f"{settings.APP_URL.rstrip('/')}/settings"

    try:
        url = await stripe_client.create_portal_session(
            customer_id=user.stripe_customer_id,
            return_url=return_url,
        )
    except stripe.error.StripeError as e:
        logger.exception("Stripe portal creation failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Stripe error: {e.user_message or str(e)}",
        )

    return PortalResponse(url=url)


@router.post("/webhook", status_code=status.HTTP_200_OK)
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(..., alias="stripe-signature"),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Receive subscription lifecycle events from Stripe."""
    settings = get_settings()
    if not settings.STRIPE_WEBHOOK_SIGNING_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook secret not configured",
        )

    payload = await request.body()
    try:
        event = stripe_client.construct_event(
            payload,
            stripe_signature,
            settings.STRIPE_WEBHOOK_SIGNING_SECRET,
        )
    except (stripe.error.SignatureVerificationError, ValueError) as e:
        logger.warning("Stripe webhook signature failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid signature",
        )

    event_type = event.get("type", "")
    data_object = event.get("data", {}).get("object", {})
    logger.info("Stripe webhook received: %s", event_type)

    if event_type == "checkout.session.completed":
        await _handle_checkout_completed(db, data_object)
    elif event_type == "customer.subscription.updated":
        await _handle_subscription_updated(db, data_object)
    elif event_type == "customer.subscription.deleted":
        await _handle_subscription_deleted(db, data_object)
    else:
        logger.debug("Unhandled Stripe event type: %s", event_type)


# ---------------------------------------------------------------------------
# Webhook handlers
# ---------------------------------------------------------------------------


async def _resolve_user(
    db: AsyncSession, *, app_user_id: Optional[str], customer_id: Optional[str]
) -> Optional[User]:
    if app_user_id:
        result = await db.execute(select(User).where(User.id == app_user_id))
        user = result.scalar_one_or_none()
        if user is not None:
            return user
    if customer_id:
        result = await db.execute(
            select(User).where(User.stripe_customer_id == customer_id)
        )
        return result.scalar_one_or_none()
    return None


async def _handle_checkout_completed(db: AsyncSession, obj: dict) -> None:
    app_user_id = (obj.get("metadata") or {}).get("app_user_id") or obj.get(
        "client_reference_id"
    )
    customer_id = obj.get("customer")
    subscription_id = obj.get("subscription")

    user = await _resolve_user(db, app_user_id=app_user_id, customer_id=customer_id)
    if user is None:
        logger.warning(
            "checkout.session.completed: cannot resolve user (app_user_id=%s, customer=%s)",
            app_user_id,
            customer_id,
        )
        return

    user.plan = "pro"
    if customer_id and not user.stripe_customer_id:
        user.stripe_customer_id = customer_id
    if subscription_id:
        user.stripe_subscription_id = subscription_id
    await db.commit()
    logger.info("User %s upgraded to pro via checkout", user.id)


async def _handle_subscription_updated(db: AsyncSession, obj: dict) -> None:
    customer_id = obj.get("customer")
    sub_id = obj.get("id")
    sub_status = obj.get("status")
    cancel_at_period_end = obj.get("cancel_at_period_end", False)

    user = await _resolve_user(db, app_user_id=None, customer_id=customer_id)
    if user is None:
        logger.warning("subscription.updated: cannot resolve customer %s", customer_id)
        return

    # Active states keep the user on Pro
    active_states = {"active", "trialing", "past_due"}
    if sub_status in active_states and not cancel_at_period_end:
        user.plan = "pro"
    elif sub_status in active_states and cancel_at_period_end:
        # Still active until period end — keep pro for now
        user.plan = "pro"
    else:
        # canceled, unpaid, incomplete_expired, etc.
        user.plan = "free"

    user.stripe_subscription_id = sub_id
    await db.commit()
    logger.info("User %s subscription updated: status=%s plan=%s", user.id, sub_status, user.plan)


async def _handle_subscription_deleted(db: AsyncSession, obj: dict) -> None:
    customer_id = obj.get("customer")
    user = await _resolve_user(db, app_user_id=None, customer_id=customer_id)
    if user is None:
        logger.warning("subscription.deleted: cannot resolve customer %s", customer_id)
        return
    user.plan = "free"
    user.stripe_subscription_id = None
    await db.commit()
    logger.info("User %s downgraded to free (subscription deleted)", user.id)
