"""Regression: the shared Supabase service-role client must use HTTP/1.1.

postgrest-py and storage3 hard-code http2=True; on our long-lived singleton
that produced HTTP/2 GOAWAY (<ConnectionTerminated error_code:1 …>) failures
mid-pipeline. get_supabase() now forces the postgrest + storage sessions to
HTTP/1.1.
"""
from __future__ import annotations

import httpx

from app.database import _force_http1, get_supabase


def _is_http2(session: httpx.Client) -> bool:
    return session._transport._pool._http2


def test_supabase_sessions_forced_to_http1():
    c = get_supabase()
    assert _is_http2(c.postgrest.session) is False
    assert _is_http2(c.storage.session) is False
    # storage keeps session and _client pointing at the same (http1) client.
    assert c.storage.session is c.storage._client


def test_force_http1_preserves_auth_base_url_and_redirects():
    src = httpx.Client(
        base_url="https://proj.supabase.co/rest/v1/",
        headers={"apikey": "svc", "Authorization": "Bearer svc"},
        follow_redirects=True,
        http2=True,
    )
    out = _force_http1(src)
    assert _is_http2(out) is False
    assert str(out.base_url) == "https://proj.supabase.co/rest/v1/"
    assert out.headers.get("apikey") == "svc"
    assert {k.lower() for k in out.headers}.issuperset({"apikey", "authorization"})
    assert out.follow_redirects is True
