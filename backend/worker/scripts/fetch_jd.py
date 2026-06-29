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


def parse_args() -> tuple[str, Optional[str], bool, str, Optional[str], dict]:
    args = sys.argv[1:]
    if not args:
        print(
            "Usage: fetch_jd.py <url> [--proxy <proxy_url>] [--no-redirect] "
            "[--method POST] [--data <body>] [--header 'K: V' ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    url = args[0]
    proxy: Optional[str] = None
    no_redirect = False
    method = "GET"
    data: Optional[str] = None
    headers: dict = {}
    i = 1
    while i < len(args):
        if args[i] == "--proxy" and i + 1 < len(args):
            proxy = args[i + 1]
            i += 2
        elif args[i] == "--no-redirect":
            no_redirect = True
            i += 1
        elif args[i] == "--method" and i + 1 < len(args):
            method = args[i + 1].upper()
            i += 2
        elif args[i] == "--data" and i + 1 < len(args):
            data = args[i + 1]
            i += 2
        elif args[i] == "--header" and i + 1 < len(args):
            raw = args[i + 1]
            if ":" in raw:
                k, v = raw.split(":", 1)
                headers[k.strip()] = v.strip()
            i += 2
        else:
            i += 1

    return url, proxy, no_redirect, method, data, headers


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
