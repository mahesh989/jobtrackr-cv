"""Metering semantics for the auto cover-letter billing gate (billing.py).

Regression cover for the bug where automation-generated cover letters bypassed
the meter entirely: the auto path had no reserve_cover_letter() equivalent to
the manual route's consumeCoverLetter(), so 134/139 of a real user's letters
never produced a usage_event. These pin the reservation decision table.
"""
import asyncio

import app.services.automation.billing as billing


# ── Fake Supabase client ──────────────────────────────────────────────────────
# Supports the fluent chains billing.py uses:
#   table(name).select(...).eq(...).limit(1).execute() -> .data (a LIST, like
#   real postgrest .limit(1) — empty on zero rows, never None)
#   rpc(name, params).execute() -> .data

class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """`rows` is the list a real .limit(1).execute() would return ([] on miss)."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *a, **k):   return self
    def eq(self, *a, **k):       return self
    def limit(self, *a, **k):    return self
    def update(self, *a, **k):   return self
    def execute(self):           return _Result(self._rows)


class _Rpc:
    def __init__(self, data):
        self._data = data

    def execute(self):
        return _Result(self._data)


class _FakeClient:
    """tables: {name: row_or_none}; rpc_result: list/row returned by consume_usage."""

    def __init__(self, tables, rpc_result=None):
        self._tables = tables
        self._rpc_result = rpc_result
        self.rpc_calls = []

    def table(self, name):
        # Real .limit(1).execute() yields a list ([] on miss). Scenarios pass a
        # single row dict (or None for "absent") — wrap to match.
        row = self._tables.get(name)
        return _Query([] if row is None else [row])

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return _Rpc(self._rpc_result)


def _patch(monkeypatch, client):
    monkeypatch.setattr(billing, "get_supabase", lambda: client)
    return client


# ── Bypass paths (event_id is None — nothing to meter) ────────────────────────

def test_admin_role_bypasses_meter(monkeypatch):
    client = _patch(monkeypatch, _FakeClient({"users": {"role": "admin"}}))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is True
    assert res.event_id is None
    assert client.rpc_calls == []  # never reached consume_usage


def test_unlimited_plan_bypasses_meter(monkeypatch):
    client = _patch(monkeypatch, _FakeClient({
        "users": {"role": "beta"},
        "subscriptions": {"plan_id": "unlimited", "status": "active",
                          "current_period_start": "2026-08-01T00:00:00+00:00"},
        "plans": {"max_letter_unique": None, "max_letter_total": None},
    }))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is True
    assert res.event_id is None
    assert client.rpc_calls == []


# ── Denials ───────────────────────────────────────────────────────────────────

def test_no_subscription_is_denied(monkeypatch):
    # Zero subscription rows. Regression guard: real .limit(1).execute() yields
    # []/None-ish here — the code must read it as "no sub", not AttributeError.
    _patch(monkeypatch, _FakeClient({"users": {"role": "beta"}, "subscriptions": None}))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is False
    assert res.reason == "no_subscription"
    assert res.event_id is None


def test_missing_user_row_defaults_to_non_admin(monkeypatch):
    # No users row at all — role must default to a non-admin ("beta") and fall
    # through to the subscription check, not crash on empty data.
    _patch(monkeypatch, _FakeClient({"users": None, "subscriptions": None}))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is False
    assert res.reason == "no_subscription"


def test_canceled_subscription_is_read_only(monkeypatch):
    _patch(monkeypatch, _FakeClient({
        "users": {"role": "beta"},
        "subscriptions": {"plan_id": "weekly", "status": "canceled",
                          "current_period_start": "2026-08-01T00:00:00+00:00"},
    }))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is False
    assert res.reason == "no_subscription"


def test_comp_active_bypasses_meter(monkeypatch):
    # comp (grandfathered), period still open -> unlimited, no reservation.
    client = _patch(monkeypatch, _FakeClient({
        "users": {"role": "beta"},
        "subscriptions": {"plan_id": "comp", "status": "comp",
                          "current_period_start": "2026-08-01T00:00:00+00:00",
                          "current_period_end": "2099-01-01T00:00:00+00:00"},
    }))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is True
    assert res.event_id is None
    assert client.rpc_calls == []


def test_comp_expired_is_read_only(monkeypatch):
    # comp whose period ended in the past -> read-only, denied.
    _patch(monkeypatch, _FakeClient({
        "users": {"role": "beta"},
        "subscriptions": {"plan_id": "comp", "status": "comp",
                          "current_period_start": "2020-01-01T00:00:00+00:00",
                          "current_period_end": "2020-02-01T00:00:00+00:00"},
    }))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is False
    assert res.reason == "no_subscription"


def test_over_cap_is_denied(monkeypatch):
    # consume_usage says no — the meter is full.
    client = _patch(monkeypatch, _FakeClient(
        tables={
            "users": {"role": "beta"},
            "subscriptions": {"plan_id": "weekly", "status": "active",
                              "current_period_start": "2026-08-01T00:00:00+00:00"},
            "plans": {"max_letter_unique": 50, "max_letter_total": 75},
        },
        rpc_result=[{"allowed": False, "reason": "unique_cap", "event_id": None}],
    ))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is False
    assert res.reason == "unique_cap"
    assert res.event_id is None
    # It DID consult consume_usage with the right kind + caps.
    assert client.rpc_calls[0][0] == "consume_usage"
    assert client.rpc_calls[0][1]["p_kind"] == "cover_letter"
    assert client.rpc_calls[0][1]["p_max_unique"] == 50
    assert client.rpc_calls[0][1]["p_max_total"] == 75


# ── Allowed path — a real reservation is made ─────────────────────────────────

def test_active_under_cap_reserves_event(monkeypatch):
    client = _patch(monkeypatch, _FakeClient(
        tables={
            "users": {"role": "beta"},
            "subscriptions": {"plan_id": "monthly", "status": "active",
                              "current_period_start": "2026-08-01T00:00:00+00:00"},
            "plans": {"max_letter_unique": 250, "max_letter_total": 375},
        },
        rpc_result=[{"allowed": True, "reason": "ok", "event_id": "evt-123"}],
    ))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is True
    assert res.event_id == "evt-123"
    assert client.rpc_calls[0][1]["p_period_start"] == "2026-08-01T00:00:00+00:00"


def test_trialing_uses_trial_caps_not_plan(monkeypatch):
    # A trialing user on the monthly plan is capped at TRIAL limits (3), not 250.
    client = _patch(monkeypatch, _FakeClient(
        tables={
            "users": {"role": "beta"},
            "subscriptions": {"plan_id": "monthly", "status": "trialing",
                              "current_period_start": "2026-08-01T00:00:00+00:00"},
            "plans": {"max_letter_unique": 3, "max_letter_total": 3},  # 'trial' row
        },
        rpc_result=[{"allowed": True, "reason": "ok", "event_id": "evt-t"}],
    ))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    assert res.allowed is True
    # Caps were loaded for the 'trial' plan id, not 'monthly'.
    assert client.rpc_calls[0][1]["p_max_unique"] == 3


# ── Fail-closed ───────────────────────────────────────────────────────────────

def test_rpc_error_fails_closed(monkeypatch):
    from postgrest.exceptions import APIError

    class _BoomRpc:
        def execute(self):
            raise APIError({"message": "db down"})

    class _BoomClient(_FakeClient):
        def rpc(self, name, params):
            self.rpc_calls.append((name, params))
            return _BoomRpc()

    _patch(monkeypatch, _BoomClient(
        tables={
            "users": {"role": "beta"},
            "subscriptions": {"plan_id": "weekly", "status": "active",
                              "current_period_start": "2026-08-01T00:00:00+00:00"},
            "plans": {"max_letter_unique": 50, "max_letter_total": 75},
        },
    ))
    res = asyncio.run(billing.reserve_cover_letter("u1", "j1"))
    # A meter outage must DENY (never give away paid work), not allow.
    assert res.allowed is False
    assert res.reason == "error"
