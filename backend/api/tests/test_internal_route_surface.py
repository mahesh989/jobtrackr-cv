"""Route-surface contract for the internal API.

The 749 unit tests cover services but never the HTTP layer, so a routing change
(e.g. splitting internal.py into domain routers) could silently drop or unguard
an endpoint with nothing to catch it. This test pins the surface:

  1. Every expected /internal/* path is registered.
  2. Every one rejects an unsigned request (HMAC dependency is in force).

It is intentionally independent of how the routers are organised internally, so
it stays green across the internal.py → routers/ refactor and guards it.
"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# (method, path) for every internal endpoint. Path params use a literal so the
# route matches; the call still rejects pre-handler on the HMAC dependency.
EXPECTED = [
    ("POST", "/internal/analyze"),
    ("POST", "/internal/extract-cv-text"),
    ("POST", "/internal/categorise-cv"),
    ("POST", "/internal/extract-cv-references"),
    ("POST", "/internal/extract-voice-fingerprint"),
    ("POST", "/internal/extract-stories"),
    ("POST", "/internal/match-stories"),
    ("POST", "/internal/scrape-jd"),
    ("POST", "/internal/research-company"),
    ("POST", "/internal/select-company-fact"),
    ("POST", "/internal/generate-opening-variants"),
    ("POST", "/internal/generate-cover-letter"),
    ("POST", "/internal/voice-rewrite-email"),
    ("POST", "/internal/classify-skills"),
]


def test_all_internal_routes_registered():
    registered = {(m, r.path) for r in app.routes for m in getattr(r, "methods", set()) or set()}
    for method, path in EXPECTED:
        assert (method, path) in registered, f"missing route: {method} {path}"


def test_every_internal_route_rejects_unsigned_request():
    for method, path in EXPECTED:
        resp = client.request(method, path, json={})
        assert resp.status_code in (401, 403), (
            f"{method} {path} returned {resp.status_code}, expected 401/403 "
            f"(HMAC guard missing or route absent)"
        )
