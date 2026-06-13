"""
SSRF guard for outbound URL fetches (JD scraping, company homepage scraping).

cv-backend fetches URLs that are ultimately influenced by user input (a
user-supplied company_domain, or a job URL that originated from scraped
third-party listings). Without a guard, an attacker can point those fetches at
internal addresses — cloud metadata (169.254.169.254), localhost, or private
RFC1918 ranges — to exfiltrate internal data or reach internal services (SSRF).

`assert_public_url` resolves the host and rejects any non-public address.
`safe_get` validates *every* redirect hop, so a public URL that 302s to an
internal one is also blocked (use it with a client that has
follow_redirects=False).

Residual risk: DNS rebinding (the name resolves to a public IP at validation
time and a private IP when httpx connects). Pinning the validated IP would
close that gap; it is out of scope here but noted for future hardening.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)


class SSRFError(Exception):
    """Raised when a URL is disallowed because it resolves to a non-public host."""


async def assert_public_url(url: str) -> None:
    """Raise SSRFError unless `url` is http(s) and every resolved IP is public."""
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise SSRFError(f"Unsupported URL scheme: {scheme or 'none'!r}")

    host = parsed.hostname
    if not host:
        raise SSRFError("URL has no host")

    port = parsed.port or (443 if scheme == "https" else 80)

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SSRFError(f"Could not resolve host {host!r}") from exc

    if not infos:
        raise SSRFError(f"Host {host!r} did not resolve")

    for info in infos:
        raw_ip = info[4][0]
        ip = ipaddress.ip_address(raw_ip)
        # Unwrap IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) so the checks
        # below see the real IPv4 address rather than treating it as "global".
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise SSRFError(
                f"Host {host!r} resolves to a non-public address ({ip})"
            )


async def safe_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_redirects: int = 5,
) -> httpx.Response:
    """
    GET `url`, validating that it (and each redirect hop) is a public address.

    The passed client MUST be configured with follow_redirects=False so we can
    inspect and validate every Location before following it.
    """
    current = url
    for _ in range(max_redirects + 1):
        await assert_public_url(current)
        resp = await client.get(current)
        location = resp.headers.get("location")
        if resp.is_redirect and location:
            current = urljoin(str(resp.url), location)
            continue
        return resp
    raise SSRFError("Too many redirects")
