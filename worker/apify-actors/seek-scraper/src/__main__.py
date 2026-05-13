"""
SEEK AU Job Scraper — Apify actor (Python)

Uses SEEK's internal GraphQL API with curl-cffi Chrome TLS impersonation.
curl-cffi spoofs Chrome 124 at the TLS handshake level (JA3/ALPN fingerprint),
which bypasses SEEK's bot detection better than plain HTTP header spoofing.
"""

import asyncio
import json
import math
import os
import uuid
from datetime import datetime, timezone

from apify import Actor
from curl_cffi.requests import AsyncSession

# ── Constants ──────────────────────────────────────────────────────────────────
SEEK_GRAPHQL_URL = "https://au.seek.com/graphql"
PAGE_SIZE = 22

HEADERS = {
    "Accept":               "application/json",
    "Accept-Language":      "en-AU,en;q=0.9",
    "Content-Type":         "application/json",
    "Origin":               "https://www.seek.com.au",
    "Referer":              "https://www.seek.com.au/",
    "seek-request-brand":   "seek",
    "seek-request-country": "AU",
    "x-seek-site":          "chalice",
}

JOB_SEARCH_QUERY = """
query JobSearchV6($params: JobSearchV6QueryInput!) {
  jobSearchV6(params: $params) {
    data {
      advertiser { id description }
      companyName
      id
      isFeatured
      listingDate { dateTimeUtc }
      locations { countryCode label }
      salaryLabel
      teaser
      title
      workTypes
    }
    totalCount
  }
}
""".strip()


def build_params(keyword: str, location: str, new_since: int, page: int) -> dict:
    """
    Build the JobSearchV6QueryInput params object.
    Matches what SEEK's own web frontend sends — extra fields (channel, source,
    session IDs, include) are required by the resolver even if not in the schema docs.
    """
    params: dict = {
        "siteKey":                "AU",
        "channel":                "mobileWeb",
        "source":                 "FE_SERP",
        "keywords":               keyword,
        "locale":                 "en-AU",
        "page":                   page,
        "pageSize":               PAGE_SIZE,
        "sortMode":               "ListedDate",
        "newSince":               new_since,
        "eventCaptureSessionId": str(uuid.uuid4()),
        "userSessionId":         str(uuid.uuid4()),
        "userQueryId":           str(uuid.uuid4()),
    }
    loc = location.strip().lower()
    if loc and loc not in ("australia", "all australia"):
        params["where"] = location.strip()
    return params


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}

        keywords:    list  = actor_input.get("keywords",   [])
        location:    str   = actor_input.get("location",   "All Australia")
        date_range:  int   = actor_input.get("dateRange",  14)
        max_results: int   = actor_input.get("maxResults", 200)

        if not keywords:
            print("[seek] No keywords provided — nothing to search.")
            return

        new_since = int(datetime.now(timezone.utc).timestamp()) - date_range * 86400
        print(f"[seek] keywords={keywords}, location={location}, dateRange={date_range}, newSince={new_since}")

        # ── Proxy setup ──────────────────────────────────────────────────────────
        # Build proxy URL directly from Apify environment variables.
        # The SDK's create_proxy_configuration() requires extra permissions on free tier;
        # using the env vars directly is equivalent and always available inside actors.
        _proxy_password = os.environ.get("APIFY_PROXY_PASSWORD", "")
        _proxy_hostname = os.environ.get("APIFY_PROXY_HOSTNAME", "proxy.apify.com")
        _proxy_port     = os.environ.get("APIFY_PROXY_PORT", "8000")

        if _proxy_password:
            _proxy_base_url = f"http://auto:{_proxy_password}@{_proxy_hostname}:{_proxy_port}"
            print(f"[seek] Proxy: {_proxy_hostname}:{_proxy_port} (password set)")
        else:
            _proxy_base_url = None
            print("[seek] Proxy: not available (no APIFY_PROXY_PASSWORD in env)")

        grand_total = 0

        # ── curl-cffi async session (impersonates Chrome 124 at TLS level) ────────
        async with AsyncSession(impersonate="chrome124") as session:

            # Warm up: hit SEEK homepage to pick up session cookies.
            # This makes GraphQL requests look like a normal browsing flow.
            try:
                proxies   = {"https": _proxy_base_url, "http": _proxy_base_url} if _proxy_base_url else None
                warmup    = await session.get("https://www.seek.com.au/", proxies=proxies, timeout=15)
                print(f"[seek] Warmup GET seek.com.au → HTTP {warmup.status_code}")
            except Exception as e:
                print(f"[seek] Warmup failed (continuing): {e}")

            for keyword in keywords:
                print(f"[{keyword}] Starting")
                page             = 1
                keyword_total    = 0
                featured_skipped = 0
                total_pages      = 1

                while keyword_total < max_results and page <= total_pages:
                    proxies = {"https": _proxy_base_url, "http": _proxy_base_url} if _proxy_base_url else None

                    gql_body = json.dumps({
                        "operationName": "JobSearchV6",
                        "query":         JOB_SEARCH_QUERY,
                        "variables":     {"params": build_params(keyword, location, new_since, page)},
                    })

                    print(f"[{keyword}] Page {page}/{total_pages} → {SEEK_GRAPHQL_URL}")

                    try:
                        resp      = await session.post(
                            SEEK_GRAPHQL_URL,
                            data=gql_body,
                            headers=HEADERS,
                            proxies=proxies,
                            timeout=30,
                        )
                        status    = resp.status_code
                        body_text = resp.text
                        print(f"[{keyword}] HTTP {status}, body {len(body_text)} chars")
                        print(f"[{keyword}] Body preview: {body_text[:600]}")
                    except Exception as e:
                        print(f"[{keyword}] Request failed: {e}")
                        break

                    if status != 200:
                        print(f"[{keyword}] Non-200 ({status}) — stopping keyword")
                        break

                    try:
                        data = json.loads(body_text)
                    except json.JSONDecodeError:
                        print(f"[{keyword}] Not valid JSON — stopping")
                        break

                    if data.get("errors"):
                        print(f"[{keyword}] GraphQL errors: {json.dumps(data['errors'])}")
                        break

                    search = (data.get("data") or {}).get("jobSearchV6")
                    if not search:
                        print(f"[{keyword}] Unexpected shape — jobSearchV6 missing")
                        break

                    jobs        = search.get("data") or []
                    total_count = search.get("totalCount") or 0
                    total_pages = max(1, math.ceil(total_count / PAGE_SIZE))

                    print(f"[{keyword}] totalCount={total_count}, totalPages={total_pages}, returned={len(jobs)}")

                    if not jobs:
                        print(f"[{keyword}] Empty page — done")
                        break

                    batch = []
                    for job in jobs:
                        if job.get("isFeatured"):
                            featured_skipped += 1
                            continue
                        if keyword_total >= max_results:
                            break

                        job_id = str(job.get("id") or "")
                        title  = job.get("title") or ""
                        if not job_id or not title:
                            continue

                        locations  = job.get("locations") or []
                        work_types = job.get("workTypes") or []
                        listing    = job.get("listingDate") or {}

                        batch.append({
                            "id":          job_id,
                            "title":       title,
                            "company":     job.get("companyName") or (job.get("advertiser") or {}).get("description", ""),
                            "location":    locations[0].get("label", "") if locations else "",
                            "area":        "",
                            "salary":      job.get("salaryLabel") or "",
                            "teaser":      job.get("teaser") or "",
                            "listingDate": listing.get("dateTimeUtc") or "",
                            "url":         f"https://www.seek.com.au/job/{job_id}",
                            "workType":    work_types[0] if work_types else "",
                            "keyword":     keyword,
                        })
                        keyword_total += 1

                    if batch:
                        await Actor.push_data(batch)

                    print(
                        f"[{keyword}] Page {page}/{total_pages}: pushed {len(batch)}, "
                        f"featured skipped {featured_skipped}, total so far {keyword_total}"
                    )

                    if len(jobs) < PAGE_SIZE or keyword_total >= max_results:
                        break
                    page += 1

                print(f"[{keyword}] Done: {keyword_total} jobs")
                grand_total += keyword_total

        print(f"[seek] Complete — {grand_total} total jobs")


asyncio.run(main())
