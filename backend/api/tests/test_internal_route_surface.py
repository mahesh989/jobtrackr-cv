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
    ("POST", "/internal/structurize-cv"),
    ("POST", "/internal/render-canonical-cv"),
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


def _discovered_internal_routes():
    """Every /internal/* (method, path) FastAPI actually has registered right now."""
    return {
        (m, r.path)
        for r in app.routes
        for m in (getattr(r, "methods", set()) or set())
        if getattr(r, "path", "").startswith("/internal/")
    }


def test_all_internal_routes_registered():
    registered = {(m, r.path) for r in app.routes for m in getattr(r, "methods", set()) or set()}
    for method, path in EXPECTED:
        assert (method, path) in registered, f"missing route: {method} {path}"


def test_EXPECTED_matches_every_registered_internal_route():
    """
    REGRESSION (#9): the old version of this file only asserted
    EXPECTED ⊆ registered, so a newly-added route that was never added to
    EXPECTED kept the suite green even with no HMAC guard at all — this
    repo's own /internal/structurize-cv and /internal/render-canonical-cv
    were exactly that: registered, but absent from EXPECTED, so
    test_every_internal_route_rejects_unsigned_request below never checked
    them (both are, as of writing, correctly guarded — this test would have
    caught it immediately if either had not been).

    Asserting EXPECTED == discovered (not just ⊆) turns "forgot to update
    the list" into an immediate, specific failure instead of a silent gap.
    """
    discovered = _discovered_internal_routes()
    expected_set = set(EXPECTED)
    missing_from_expected = discovered - expected_set
    missing_from_app = expected_set - discovered
    assert not missing_from_expected, (
        f"route(s) registered but not covered by the HMAC-reject test below — add to "
        f"EXPECTED: {sorted(missing_from_expected)}"
    )
    assert not missing_from_app, (
        f"EXPECTED lists route(s) no longer registered — remove from EXPECTED: "
        f"{sorted(missing_from_app)}"
    )


def test_every_internal_route_rejects_unsigned_request():
    # Iterates the LIVE discovered set, not the static EXPECTED list, so a
    # route added without updating EXPECTED is still checked here even if
    # the equality test above is ever skipped/removed — belt and suspenders
    # against #9's exact failure mode, not just a single point of coverage.
    for method, path in _discovered_internal_routes():
        resp = client.request(method, path, json={})
        assert resp.status_code in (401, 403), (
            f"{method} {path} returned {resp.status_code}, expected 401/403 "
            f"(HMAC guard missing or route absent)"
        )
