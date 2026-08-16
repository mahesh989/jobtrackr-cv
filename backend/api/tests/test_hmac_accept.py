"""
Coverage gap (audit, execution chunk C41a): `verify_hmac` (app/security/hmac.py)
had test coverage only for its REJECT paths — test_internal_route_surface.py's
`test_every_internal_route_rejects_unsigned_request` only ever sends unsigned
requests. Nothing in the suite had ever constructed a genuinely valid
signature and confirmed the dependency lets the request through, or exercised
the timestamp-window boundary, malformed-timestamp, or tampered-signature
paths precisely.

Uses a tiny standalone FastAPI app with `verify_hmac` as its only dependency,
rather than a real /internal/* route, so these tests exercise the dependency
in isolation — a real route's own business logic (DB calls, AI calls) would
fail for unrelated reasons and obscure what's actually being tested here.
"""
import hashlib
import hmac as hmac_lib
import time
from unittest.mock import patch

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.security.hmac import MAX_AGE_SECONDS, verify_hmac

SECRET = "test-secret"  # matches conftest.py's JOBTRACKR_HMAC_SECRET

probe_app = FastAPI()


@probe_app.post("/probe", dependencies=[Depends(verify_hmac)])
def probe():
    return {"ok": True}


client = TestClient(probe_app)


def sign(body: bytes, ts: int, secret: str = SECRET) -> str:
    message = f"{ts}".encode() + body
    return hmac_lib.new(secret.encode(), message, hashlib.sha256).hexdigest()


def post(body: bytes, ts: int, sig: str):
    return client.post(
        "/probe",
        content=body,
        headers={
            "x-timestamp": str(ts),
            "x-signature": sig,
            "content-type": "application/json",
        },
    )


def test_a_validly_signed_fresh_request_reaches_the_handler():
    body = b'{"hello": "world"}'
    ts = int(time.time())
    resp = post(body, ts, sign(body, ts))
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_timestamp_exactly_at_the_max_age_boundary_is_still_accepted():
    # verify_hmac rejects only when abs(now - ts) > MAX_AGE_SECONDS (strictly
    # greater), so exactly MAX_AGE_SECONDS old is the last accepted instant.
    body = b"{}"
    ts = int(time.time()) - MAX_AGE_SECONDS
    resp = post(body, ts, sign(body, ts))
    assert resp.status_code == 200


def test_timestamp_one_second_past_the_max_age_boundary_is_rejected():
    body = b"{}"
    ts = int(time.time()) - MAX_AGE_SECONDS - 1
    resp = post(body, ts, sign(body, ts))
    assert resp.status_code == 401
    assert "window" in resp.json()["detail"].lower()


def test_a_future_timestamp_at_the_boundary_is_accepted_and_past_it_rejected():
    body = b"{}"
    now = int(time.time())

    at_boundary = now + MAX_AGE_SECONDS
    resp = post(body, at_boundary, sign(body, at_boundary))
    assert resp.status_code == 200

    past_boundary = now + MAX_AGE_SECONDS + 1
    resp = post(body, past_boundary, sign(body, past_boundary))
    assert resp.status_code == 401


def test_non_integer_timestamp_is_rejected_not_500d():
    body = b"{}"
    resp = client.post(
        "/probe",
        content=body,
        headers={"x-timestamp": "not-a-number", "x-signature": "irrelevant"},
    )
    assert resp.status_code == 401
    assert "integer" in resp.json()["detail"].lower()


def test_a_decimal_timestamp_string_is_rejected_int_parse_only():
    body = b"{}"
    resp = client.post(
        "/probe",
        content=body,
        headers={"x-timestamp": "12345.5", "x-signature": "irrelevant"},
    )
    assert resp.status_code == 401


def test_body_tampered_after_signing_is_rejected():
    ts = int(time.time())
    sig = sign(b'{"amount": 1}', ts)
    resp = post(b'{"amount": 999}', ts, sig)
    assert resp.status_code == 401
    assert "mismatch" in resp.json()["detail"].lower()


def test_signature_signed_with_the_wrong_secret_is_rejected():
    body = b"{}"
    ts = int(time.time())
    resp = post(body, ts, sign(body, ts, secret="wrong-secret"))
    assert resp.status_code == 401


def test_truncated_signature_is_rejected_not_a_crash():
    body = b"{}"
    ts = int(time.time())
    full_sig = sign(body, ts)
    resp = post(body, ts, full_sig[:10])
    assert resp.status_code == 401


def test_missing_timestamp_header_is_rejected():
    body = b"{}"
    resp = client.post("/probe", content=body, headers={"x-signature": "whatever"})
    assert resp.status_code == 401
    assert "missing" in resp.json()["detail"].lower()


def test_missing_signature_header_is_rejected():
    body = b"{}"
    resp = client.post("/probe", content=body, headers={"x-timestamp": str(int(time.time()))})
    assert resp.status_code == 401


def test_unconfigured_secret_fails_loud_with_500_not_a_silent_accept():
    body = b"{}"
    ts = int(time.time())
    sig = sign(body, ts)

    class _NoSecretSettings:
        JOBTRACKR_HMAC_SECRET = ""

    with patch("app.security.hmac.get_settings", return_value=_NoSecretSettings()):
        resp = post(body, ts, sig)
    assert resp.status_code == 500
