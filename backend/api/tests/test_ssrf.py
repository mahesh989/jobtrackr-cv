"""
Coverage gap (audit, execution chunk C41c): app/security/ssrf.py — the SSRF
guard for outbound URL fetches (JD scraping, company homepage scraping) —
had zero test coverage anywhere in the suite before this file.

DNS resolution is faked by monkeypatching `getaddrinfo` on the REAL running
event loop (not by replacing `asyncio.get_running_loop` wholesale, which
would interfere with the test's own async machinery) — this lets
`assert_public_url`'s `await loop.getaddrinfo(...)` call resolve to a
controlled IP without a real network lookup. `safe_get` is tested against a
minimal duck-typed fake client (an async `.get()` method returning real
`httpx.Response` objects) rather than a real HTTP server.

Uses this suite's established `_await()` convention (test_summary_anchor_retry.py)
— `asyncio.get_event_loop().run_until_complete(coro)`, NOT
`@pytest.mark.asyncio` / `asyncio.run()`. This isn't a style preference:
pytest-asyncio's per-test loop teardown calls `asyncio.set_event_loop(None)`,
which poisons the deprecated `asyncio.get_event_loop()` implicit-loop
fallback that OTHER test files in this suite (test_writer_w8_upload_threading.py,
test_targeted_bullet_rewrites.py) rely on via their own `_await()` helpers —
any `@pytest.mark.asyncio` test running immediately before them in collection
order breaks them with "RuntimeError: There is no current event loop in
thread 'MainThread'" (verified directly: even the pre-existing
test_cover_letter_honesty_gate_degraded.py triggers this if placed adjacent).
Matching the established convention avoids the landmine entirely.

Note: there is a SEPARATE, already-tested frontend SSRF guard at
frontend/web/src/lib/ssrf.ts / ssrf.test.ts — unrelated to this file.
"""
from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from app.security.ssrf import SSRFError, assert_public_url, safe_get


def _await(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _fake_resolution(loop, monkeypatch, *tuples):
    """Monkeypatch `loop`'s getaddrinfo to return `tuples`, each a raw IP
    string resolved in order (round-robin across calls if safe_get resolves
    multiple hops)."""
    remaining = list(tuples)

    async def fake_getaddrinfo(host, port, type=None):
        ip = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        family = socket.AF_INET6 if ":" in ip else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (ip, port))]

    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo)


def _fake_resolution_error(loop, monkeypatch):
    async def fake_getaddrinfo(host, port, type=None):
        raise socket.gaierror("name or service not known")

    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo)


class FakeClient:
    """Duck-typed stand-in for httpx.AsyncClient — safe_get only ever calls
    .get(url), so that's the only method implemented."""

    def __init__(self, responses: list[httpx.Response]):
        self._responses = list(responses)
        self.requested_urls: list[str] = []

    async def get(self, url: str) -> httpx.Response:
        self.requested_urls.append(url)
        return self._responses.pop(0)


def _response(url: str, status: int, location: str | None = None) -> httpx.Response:
    headers = {"location": location} if location else {}
    return httpx.Response(status, headers=headers, request=httpx.Request("GET", url))


# ── assert_public_url ───────────────────────────────────────────────────────


def test_rejects_unsupported_scheme():
    with pytest.raises(SSRFError, match="scheme"):
        _await(assert_public_url("ftp://example.com"))


def test_rejects_a_valid_scheme_url_with_no_host():
    with pytest.raises(SSRFError, match="no host"):
        _await(assert_public_url("http:///path-only-no-host"))


def test_rejects_a_private_rfc1918_address(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "10.1.2.3")
    with pytest.raises(SSRFError, match="non-public"):
        _await(assert_public_url("http://internal.example.com"))


def test_rejects_loopback(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "127.0.0.1")
    with pytest.raises(SSRFError):
        _await(assert_public_url("http://localhost"))


def test_rejects_the_cloud_metadata_link_local_address(monkeypatch):
    # 169.254.169.254 — the exact threat named in the module docstring
    # (AWS/GCP/Azure instance-metadata endpoint).
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "169.254.169.254")
    with pytest.raises(SSRFError):
        _await(assert_public_url("http://metadata.internal"))


def test_rejects_unspecified_and_multicast_and_reserved(monkeypatch):
    loop = asyncio.get_event_loop()
    for ip in ("0.0.0.0", "224.0.0.1", "240.0.0.1"):
        _fake_resolution(loop, monkeypatch, ip)
        with pytest.raises(SSRFError):
            _await(assert_public_url("http://whatever.example.com"))


def test_unwraps_an_ipv4_mapped_ipv6_metadata_address(monkeypatch):
    # The trickiest branch: ::ffff:169.254.169.254 must be unwrapped to its
    # real IPv4 form before the public/private checks run, not treated as
    # an ordinary (falsely "global") IPv6 address.
    loop = asyncio.get_event_loop()

    async def fake_getaddrinfo(host, port, type=None):
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:169.254.169.254", port, 0, 0))]

    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(SSRFError, match="non-public"):
        _await(assert_public_url("http://sneaky.example.com"))


def test_a_genuine_public_ip_passes(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "93.184.216.34")  # example.com's real public IP
    _await(assert_public_url("http://example.com"))  # must not raise


def test_dns_resolution_failure_raises_ssrferror_not_an_unhandled_exception(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution_error(loop, monkeypatch)
    with pytest.raises(SSRFError, match="Could not resolve"):
        _await(assert_public_url("http://does-not-exist.invalid"))


# ── safe_get ─────────────────────────────────────────────────────────────────


def test_safe_get_returns_the_response_for_a_plain_non_redirecting_public_url(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "93.184.216.34")
    client = FakeClient([_response("http://example.com", 200)])
    resp = _await(safe_get(client, "http://example.com"))
    assert resp.status_code == 200
    assert client.requested_urls == ["http://example.com"]


def test_safe_get_validates_every_redirect_hop_and_follows_a_public_chain(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "93.184.216.34")
    client = FakeClient(
        [
            _response("http://a.example.com", 302, location="http://b.example.com"),
            _response("http://b.example.com", 200),
        ]
    )
    resp = _await(safe_get(client, "http://a.example.com"))
    assert resp.status_code == 200
    assert client.requested_urls == ["http://a.example.com", "http://b.example.com"]


def test_safe_get_blocks_a_public_url_that_redirects_to_a_private_ip_mid_chain(monkeypatch):
    # The core "residual risk, handled" case the module docstring calls out:
    # a 302 Location pointing at an internal address must be blocked BEFORE
    # it's ever fetched, not silently followed.
    loop = asyncio.get_event_loop()
    call_count = {"n": 0}

    async def fake_getaddrinfo(host, port, type=None):
        call_count["n"] += 1
        ip = "93.184.216.34" if call_count["n"] == 1 else "127.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo)

    client = FakeClient(
        [_response("http://public.example.com", 302, location="http://internal.example.com/secret")]
    )
    with pytest.raises(SSRFError):
        _await(safe_get(client, "http://public.example.com"))
    # The first (public) hop is legitimately fetched — it's the REDIRECT
    # TARGET that must be blocked before it's ever requested.
    assert client.requested_urls == ["http://public.example.com"]


def test_safe_get_raises_after_exceeding_max_redirects(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "93.184.216.34")
    # 4 chained redirects with max_redirects=3 — one more hop than allowed.
    client = FakeClient(
        [
            _response("http://h0.example.com", 302, location="http://h1.example.com"),
            _response("http://h1.example.com", 302, location="http://h2.example.com"),
            _response("http://h2.example.com", 302, location="http://h3.example.com"),
            _response("http://h3.example.com", 302, location="http://h4.example.com"),
        ]
    )
    with pytest.raises(SSRFError, match="Too many redirects"):
        _await(safe_get(client, "http://h0.example.com", max_redirects=3))


def test_safe_get_a_relative_redirect_location_resolves_against_the_current_url(monkeypatch):
    loop = asyncio.get_event_loop()
    _fake_resolution(loop, monkeypatch, "93.184.216.34")
    client = FakeClient(
        [
            _response("http://example.com/start", 302, location="/relative-path"),
            _response("http://example.com/relative-path", 200),
        ]
    )
    resp = _await(safe_get(client, "http://example.com/start"))
    assert resp.status_code == 200
    assert client.requested_urls == ["http://example.com/start", "http://example.com/relative-path"]
