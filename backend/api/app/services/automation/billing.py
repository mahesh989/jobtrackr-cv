"""
Auto cover-letter billing reservation — the metering choke point for the
AUTO generation path (auto_cover_letter.py).

Why this exists
---------------
The manual cover-letter route (frontend/web .../coverLetter/start.ts) reserves a
`cover_letter` usage_event via consumeCoverLetter(). The AUTO path had no
equivalent, so every automation-generated cover letter was free — the billing
meter counted only the handful of manually-triggered ones. This module closes
that gap so both paths meter identically.

It is a THIRD language-mirror of the same entitlement resolution that already
lives in:
  - frontend/web/src/lib/billing/entitlements.ts   (web, manual paths)
  - backend/worker/src/automation/billing.ts        (worker, auto-tailored-CV)
backend/api cannot import either (separate package + separate language), so the
minimal plan->caps->period resolution is duplicated here — the same trade the
worker mirror already made. KEEP IN SYNC with those two files + the `plans`
seed (shared/supabase/migrations/003_seed.sql).

Lifecycle (identical to the manual route and the auto-CV path)
--------------------------------------------------------------
  1. reserve_cover_letter() — atomic cap-check + a PENDING usage_event via the
     existing consume_usage RPC. Denied -> caller skips generation.
  2. After the cover_letters row is inserted, link_letter_usage_event(event_id,
     letter_id) sets usage_events.ref_id = letter_id.
  3. The cover_letters status trigger (cover_letters_usage_sync, migration 051)
     COMMITS the event on status='completed' or VOIDS it on 'failed'.
  4. If the letter row is never created, the caller voids the reservation with
     release_letter_usage_event().

Founder/admin, comp, unlimited plans, and trial-with-no-period bypass the meter
(event_id = None -> nothing to link/void). Fails CLOSED on RPC error, matching
both mirrors — a billing-meter outage must never give away paid work.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from postgrest.exceptions import APIError

from app.database import get_supabase

logger = logging.getLogger(__name__)

_USERS         = "users"
_SUBSCRIPTIONS = "subscriptions"
_PLANS         = "plans"
_USAGE_EVENTS  = "usage_events"

_ADMIN_ROLES = frozenset({"founder", "admin"})

# Letter caps per plan — typed mirror of the `plans` seed / PLAN_LIMITS. The
# plans table is authoritative and read first; this is the fallback only.
# None = unlimited for that dimension. KEEP IN SYNC with 003_seed.sql.
_PLAN_LETTER_LIMITS: dict[str, dict[str, Optional[int]]] = {
    "trial":     {"unique": 3,    "total": 3},
    "weekly":    {"unique": 50,   "total": 75},
    "monthly":   {"unique": 250,  "total": 375},
    "unlimited": {"unique": None, "total": None},
    "comp":      {"unique": None, "total": None},
}


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    """PostgREST ISO timestamp -> aware datetime (None on absent/unparseable)."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


class LetterReservation:
    """Result of reserve_cover_letter()."""

    __slots__ = ("allowed", "reason", "event_id")

    def __init__(self, allowed: bool, reason: Optional[str], event_id: Optional[str]) -> None:
        self.allowed = allowed
        self.reason = reason
        # None when the user bypasses the meter (admin/unlimited) — nothing to link/void.
        self.event_id = event_id


async def reserve_cover_letter(user_id: str, job_id: str) -> LetterReservation:
    """Atomic cap-check + PENDING usage_event for an auto-generated cover letter.

    Returns allowed=False (caller should skip) when the user is over cap or has
    no write access. event_id is None whenever the user bypasses the meter.
    Never raises — resolves to a denial (fail-closed) on any error.
    """
    sb = get_supabase()

    # Founder/admin bypass everything. (.limit(1) — not .single()/.maybe_single()
    # which raise or return None on zero rows; a plain list is None-safe.)
    try:
        user_row = await asyncio.to_thread(
            lambda: sb.table(_USERS).select("role").eq("id", user_id).limit(1).execute()
        )
    except APIError as exc:
        logger.error("auto-cl-billing: user role lookup failed for %s: %s", user_id, exc)
        return LetterReservation(False, "error", None)
    role = ((user_row.data or [{}])[0] or {}).get("role") or "beta"
    if role in _ADMIN_ROLES:
        return LetterReservation(True, None, None)

    try:
        sub_row = await asyncio.to_thread(
            lambda: sb.table(_SUBSCRIPTIONS)
            .select("plan_id, status, current_period_start, current_period_end")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
    except APIError as exc:
        logger.error("auto-cl-billing: subscription lookup failed for %s: %s", user_id, exc)
        return LetterReservation(False, "error", None)

    sub = (sub_row.data or [None])[0]
    if not sub:
        return LetterReservation(False, "no_subscription", None)

    status = sub.get("status")
    period_start = sub.get("current_period_start")

    # comp (grandfathered) — unlimited until period end, then read-only.
    if status == "comp":
        end = _parse_ts(sub.get("current_period_end"))
        if end is not None and datetime.now(timezone.utc) > end:
            return LetterReservation(False, "no_subscription", None)
        return LetterReservation(True, None, None)

    # Only active-ish states get write access; everything else is read-only.
    if status not in ("trialing", "active", "past_due"):
        return LetterReservation(False, "no_subscription", None)

    # Trial enforces TRIAL caps regardless of the chosen plan.
    effective_plan = "trial" if status == "trialing" else (sub.get("plan_id") or "trial")
    caps = await _load_letter_caps(effective_plan)

    # Unlimited plan, or no billing period to count against -> no reservation.
    if (caps["unique"] is None and caps["total"] is None) or not period_start:
        return LetterReservation(True, None, None)

    try:
        result = await asyncio.to_thread(
            lambda: sb.rpc(
                "consume_usage",
                {
                    "p_user": user_id,
                    "p_kind": "cover_letter",
                    "p_job": job_id,
                    "p_max_unique": caps["unique"],
                    "p_max_total": caps["total"],
                    "p_period_start": period_start,
                },
            ).execute()
        )
    except APIError as exc:
        # Fail CLOSED — a billing-meter outage must not give away paid work.
        logger.error("auto-cl-billing: consume_usage RPC failed for %s: %s", user_id, exc)
        return LetterReservation(False, "error", None)

    data = result.data
    row = data[0] if isinstance(data, list) else data
    if not row:
        logger.error("auto-cl-billing: consume_usage returned no row for %s", user_id)
        return LetterReservation(False, "error", None)

    return LetterReservation(
        allowed=bool(row.get("allowed")),
        reason=row.get("reason") or "error",
        event_id=row.get("event_id"),
    )


async def _load_letter_caps(plan_id: str) -> dict[str, Optional[int]]:
    """DB-authoritative letter caps with a typed _PLAN_LETTER_LIMITS fallback."""
    sb = get_supabase()
    try:
        row = await asyncio.to_thread(
            lambda: sb.table(_PLANS)
            .select("max_letter_unique, max_letter_total")
            .eq("id", plan_id)
            .limit(1)
            .execute()
        )
        data = (row.data or [None])[0]
        if data:
            return {
                "unique": data.get("max_letter_unique"),
                "total": data.get("max_letter_total"),
            }
    except APIError as exc:
        logger.warning("auto-cl-billing: plans lookup failed for %s (using fallback): %s", plan_id, exc)
    return _PLAN_LETTER_LIMITS.get(plan_id, _PLAN_LETTER_LIMITS["trial"])


async def link_letter_usage_event(event_id: str, letter_id: str) -> None:
    """Link a pending reservation to the letter row so the status trigger commits/voids it."""
    sb = get_supabase()
    try:
        await asyncio.to_thread(
            lambda: sb.table(_USAGE_EVENTS).update({"ref_id": letter_id}).eq("id", event_id).execute()
        )
    except APIError as exc:  # noqa: BLE001 — best effort; an unlinked pending event self-heals in 1h
        logger.error("auto-cl-billing: could not link usage_event %s -> letter %s: %s", event_id, letter_id, exc)


async def release_letter_usage_event(event_id: str) -> None:
    """Void a reservation when no letter row will be created (early-return path)."""
    sb = get_supabase()
    try:
        await asyncio.to_thread(
            lambda: sb.table(_USAGE_EVENTS)
            .update({"status": "voided"})
            .eq("id", event_id)
            .eq("status", "pending")
            .execute()
        )
    except APIError as exc:  # noqa: BLE001 — best effort; a dangling pending event self-heals in 1h
        logger.error("auto-cl-billing: could not release usage_event %s: %s", event_id, exc)
