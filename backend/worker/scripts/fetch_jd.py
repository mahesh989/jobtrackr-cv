#!/usr/bin/env python3
"""
fetch_jd.py — fetch a URL using curl_cffi (Chrome 124 TLS impersonation).

Used by the JobTrackr worker to bypass Cloudflare bot protection on SEEK
and Careerjet job-description pages. Spawned as a subprocess by curlfetch.ts.

Why curl_cffi beats got-scraping:
  curl_cffi patches libcurl's TLS stack to emit real Chrome JA3 + ALPN
  fingerprints. Cloudflare's TLS fingerprinting ("ja3") sees Chrome, not curl.
  got-scraping's Node.js TLS spoofing is weaker and detectable from datacenter
  IPs. curl_cffi works from residential IPs without any proxy; from datacenter
  IPs (Fly.io) the optional --proxy arg routes through an Apify residential AU
  IP to pass Cloudflare's IP-reputation check as well.

Usage:
    python3 fetch_jd.py <url>
    python3 fetch_jd.py <url> --proxy <http://user:pass@host:port>
    python3 fetch_jd.py <url> --method POST --data '{"k":"v"}' --header 'Accept: application/json'

Output:
    Single JSON line to stdout: {"status": N, "body": "..."}
    Error text to stderr + exit code 1 on failure.
    Exit code 2 if curl_cffi is not installed.
"""
from __future__ import annotations

import json
import sys
from typing import Optional

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print(
        "curl_cffi not installed. Run: pip install curl_cffi",
        file=sys.stderr,
    )
    sys.exit(2)


def _parse_header(raw: str) -> tuple[str, str]:
    k, _, v = raw.partition(":")
    return k.strip(), v.strip()


def parse_args() -> tuple[str, Optional[str], bool, str, Optional[str], dict]:
    from argparse import ArgumentParser

    p = ArgumentParser(description="Fetch a URL via curl_cffi (Chrome 124 TLS impersonation).")
    p.add_argument("url")
    p.add_argument("--proxy", default=None)
    p.add_argument("--no-redirect", action="store_true")
    p.add_argument("--method", default="GET")
    p.add_argument("--data", default=None)
    p.add_argument("--header", action="append", default=[])
    a = p.parse_args()
    return a.url, a.proxy, a.no_redirect, a.method.upper(), a.data, dict(_parse_header(h) for h in a.header)


def main() -> None:
    url, proxy_url, no_redirect, method, data, extra_headers = parse_args()

    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None

    # Sensible defaults; caller-supplied --header values override these.
    base_headers = {
        "Accept": "application/json"
        if method == "POST"
        else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    if method == "POST" and data is not None:
        base_headers.setdefault("Content-Type", "application/json")
    base_headers.update(extra_headers)

    try:
        common = dict(
            impersonate="chrome124",
            proxies=proxies,
            timeout=25,
            headers=base_headers,
            allow_redirects=not no_redirect,
        )
        if method == "POST":
            resp = cffi_requests.post(url, data=data, **common)
        else:
            resp = cffi_requests.get(url, **common)
    except Exception as exc:
        print(f"fetch error: {exc}", file=sys.stderr)
        sys.exit(1)

    # Also expose the final URL after redirect chain and the Location header
    # (useful when allow_redirects=False to extract the redirect target).
    final_url = str(resp.url) if hasattr(resp, "url") else url
    location = resp.headers.get("location") or resp.headers.get("Location") or ""

    # Single compact JSON line to stdout — TypeScript side parses this
    print(json.dumps(
        {
            "status":   resp.status_code,
            "body":     "" if no_redirect else resp.text,
            "url":      final_url,
            "location": location,
        },
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
