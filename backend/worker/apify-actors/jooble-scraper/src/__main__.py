"""
Jooble AU Job Scraper — Apify actor (Python)

Phase 1 — Listings:  Calls Jooble's official JSON API (POST /api/{key}).
                      No browser, no Cloudflare — identical architecture to
                      the SEEK actor which calls SEEK's GraphQL API directly.

Phase 2 — Descriptions: Visits each job's Jooble /jdp/ detail page with
                         Playwright + Apify residential proxy.
                         Jooble's detail pages are behind Cloudflare, but
                         Apify residential proxies pass right through.

Input:  { apiKey: str, keywords: list[str], location?: str,
          maxResults?: int, fetchDescriptions?: bool }
Output: { id, title, company, location, salary, teaser, description,
          listingDate, source, url, workType, keyword }
"""

import asyncio
import html
import json
import os
import re
from typing import Optional
from urllib.parse import urlencode

from apify import Actor
from curl_cffi.requests import AsyncSession
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

# ── Jooble API ─────────────────────────────────────────────────────────────────
JOOBLE_API_BASE = "https://jooble.org/api"
PAGE_SIZE = 20

# ── Description selectors — tried in order, first match >150 chars wins ────────
DESCRIPTION_SELECTORS = [
    # Jooble's own /jdp/ pages
    ".vacancy-description",
    ".vacancy-desc",
    "[class*='vacancy']",
    "[class*='jobDescription']",
    # SEEK
    '[data-automation="jobAdDetails"]',
    # Indeed
    "#jobDescriptionText",
    ".jobsearch-jobDescriptionText",
    # LinkedIn
    ".jobs-description__content",
    ".description__text",
    # Adzuna / Swooped / generic
    ".adp-body",
    '[data-testid="job-description"]',
    '[itemprop="description"]',
    ".job-description",
    ".description",
    "article section",
    "article",
    "main",
]

OVERLAY_JS = """() => {
    document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], [id*="cookie"], [id*="modal"],
         [class*="modal"], [class*="overlay"], [class*="cookie"]'
    ).forEach(el => el.remove());
}"""


# ── Helpers ────────────────────────────────────────────────────────────────────

def _clean_snippet(raw: str) -> str:
    """Strip HTML tags and entities from Jooble's snippet field."""
    if not raw:
        return ""
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", " ", raw)
    # Decode entities (&nbsp; &amp; etc.)
    text = html.unescape(text)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    # Remove leading ellipsis that Jooble adds
    return re.sub(r"^[.\s]+", "", text)


def _clean_id(raw_id) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", str(raw_id))[:64]


def _normalize_location(location: str) -> str:
    """
    Jooble API uses 'Australia' (not 'All Australia') for AU-wide results.
    Empty string returns global results — avoid that.
    """
    loc = location.strip().lower()
    if loc in ("", "all australia"):
        return "Australia"
    return location.strip()


def _build_api_body(keyword: str, location: str, page: int) -> str:
    return json.dumps({
        "keywords":     keyword,
        "location":     location,
        "page":         page,
        "resultonpage": PAGE_SIZE,
    })


async def _dismiss_overlays(page: Page) -> None:
    try:
        await page.evaluate(OVERLAY_JS)
    except Exception:
        pass


async def _extract_description(page: Page) -> str:
    for sel in DESCRIPTION_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el:
                text = (await el.inner_text()).strip()
                if len(text) > 150:
                    return text
        except Exception:
            continue
    return ""


async def _get_description(page: Page, jdp_url: str) -> str:
    """Visit the Jooble /jdp/ detail page and extract the full description."""
    if not jdp_url:
        return ""
    try:
        await page.goto(jdp_url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        await _dismiss_overlays(page)

        # If Cloudflare challenge page appeared, wait for it to resolve
        title = await page.title()
        if "just a moment" in title.lower():
            Actor.log.debug(f"Cloudflare challenge on {jdp_url}, waiting...")
            await page.wait_for_timeout(6000)

        return await _extract_description(page)
    except Exception as e:
        Actor.log.debug(f"Description failed for {jdp_url}: {e}")
        return ""


def _build_proxy_url() -> Optional[str]:
    """
    Build Apify residential proxy URL from environment variables.
    Returns None when running outside Apify (local dev / no proxy available).
    """
    password = os.environ.get("APIFY_PROXY_PASSWORD", "")
    if not password:
        return None
    hostname = os.environ.get("APIFY_PROXY_HOSTNAME", "proxy.apify.com")
    port     = os.environ.get("APIFY_PROXY_PORT", "8000")
    # Use residential proxies (AU country) to pass Cloudflare on Jooble /jdp/ pages
    return f"http://groups-RESIDENTIAL,country-AU:{password}@{hostname}:{port}"


async def _make_context(browser: Browser, proxy_url: Optional[str]) -> BrowserContext:
    kwargs = dict(
        viewport={"width": 1366, "height": 768},
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        locale="en-AU",
        timezone_id="Australia/Sydney",
    )
    if proxy_url:
        kwargs["proxy"] = {"server": proxy_url}

    ctx = await browser.new_context(**kwargs)
    await ctx.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
    )
    return ctx


def _build_row(job: dict, description: str, keyword: str) -> dict:
    return {
        "id":          _clean_id(job.get("id", "")),
        "title":       (job.get("title")    or "").strip(),
        "company":     (job.get("company")  or "").strip(),
        "location":    (job.get("location") or "").strip(),
        "salary":      (job.get("salary")   or "").strip(),
        "teaser":      _clean_snippet(job.get("snippet") or ""),
        "description": description,
        "listingDate": (job.get("updated")  or "").strip(),
        "source":      (job.get("source")   or "").strip(),
        "url":         (job.get("link")     or "").strip(),
        "workType":    (job.get("type")     or "").strip(),
        "keyword":     keyword,
    }


# ── Main ───────────────────────────────────────────────────────────────────────

async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}

        api_key: str = actor_input.get("apiKey", "").strip()
        if not api_key:
            Actor.log.error("apiKey is required — register free at https://jooble.org/api/about")
            return

        raw_kws: list = actor_input.get("keywords", [])
        if not raw_kws and actor_input.get("query"):
            raw_kws = [actor_input["query"]]
        keywords:    list = [str(k).strip() for k in raw_kws if str(k).strip()]
        location:    str  = _normalize_location(actor_input.get("location", "All Australia"))
        max_results: int  = int(actor_input.get("maxResults", 100))
        fetch_desc:  bool = bool(actor_input.get("fetchDescriptions", True))

        if not keywords:
            Actor.log.error("No keywords provided — nothing to search.")
            return

        Actor.log.info(
            f"Jooble scraper — keywords={keywords}, location={location!r}, "
            f"maxResults={max_results}, fetchDescriptions={fetch_desc}"
        )

        proxy_url = _build_proxy_url()
        if fetch_desc:
            if proxy_url:
                Actor.log.info("Proxy: Apify residential (AU) — Cloudflare on /jdp/ pages will be bypassed")
            else:
                Actor.log.warning(
                    "No APIFY_PROXY_PASSWORD — Jooble /jdp/ pages may be blocked by Cloudflare. "
                    "Run on Apify platform to enable proxies, or set fetchDescriptions=false."
                )

        grand_total = 0

        async with AsyncSession(impersonate="chrome124") as session:

            for keyword in keywords:
                Actor.log.info(f"[{keyword}] Fetching listings from Jooble API...")
                all_jobs: list = []
                seen_ids: set  = set()
                api_page = 1

                # ── Phase 1: listings via API ─────────────────────────────────
                while len(all_jobs) < max_results:
                    api_url = f"{JOOBLE_API_BASE}/{api_key}"
                    body    = _build_api_body(keyword, location, api_page)

                    Actor.log.info(f"[{keyword}] API page {api_page}")
                    try:
                        resp = await session.post(
                            api_url,
                            data=body,
                            headers={"Content-Type": "application/json"},
                            timeout=30,
                        )
                    except Exception as e:
                        Actor.log.error(f"[{keyword}] API request failed: {e}")
                        break

                    if resp.status_code != 200:
                        Actor.log.warning(f"[{keyword}] API HTTP {resp.status_code} — stopping")
                        break

                    try:
                        data = resp.json()
                    except Exception:
                        Actor.log.warning(f"[{keyword}] API returned non-JSON")
                        break

                    total_count: int = data.get("totalCount", 0)
                    jobs: list       = data.get("jobs", [])
                    Actor.log.info(
                        f"[{keyword}] totalCount={total_count}, returned={len(jobs)}"
                    )

                    if not jobs:
                        break

                    for job in jobs:
                        job_id = _clean_id(job.get("id", ""))
                        if not job_id or job_id in seen_ids:
                            continue
                        seen_ids.add(job_id)
                        all_jobs.append(job)
                        if len(all_jobs) >= max_results:
                            break

                    if len(jobs) < PAGE_SIZE or len(all_jobs) >= max_results:
                        break
                    api_page += 1

                Actor.log.info(f"[{keyword}] {len(all_jobs)} listings collected")

                # ── Phase 2: descriptions via Playwright ──────────────────────
                if fetch_desc and all_jobs:
                    async with async_playwright() as p:
                        browser: Browser = await p.chromium.launch(
                            headless=True,
                            args=[
                                "--disable-blink-features=AutomationControlled",
                                "--no-sandbox",
                                "--disable-setuid-sandbox",
                                "--disable-dev-shm-usage",
                            ],
                        )
                        ctx  = await _make_context(browser, proxy_url)
                        page = await ctx.new_page()

                        batch: list = []
                        for i, job in enumerate(all_jobs):
                            jdp_url = (job.get("link") or "").strip()
                            title   = (job.get("title") or "").strip()
                            Actor.log.info(
                                f"[{keyword}] [{i+1}/{len(all_jobs)}] {title[:70]}"
                            )

                            desc = await _get_description(page, jdp_url)
                            status = f"{len(desc)} chars" if desc else "no description"
                            Actor.log.info(f"[{keyword}] [{i+1}] description: {status}")

                            batch.append(_build_row(job, desc, keyword))
                            await asyncio.sleep(1.5)

                        await browser.close()

                else:
                    batch = [_build_row(job, "", keyword) for job in all_jobs]
                    if not fetch_desc:
                        Actor.log.info(f"[{keyword}] fetchDescriptions=false — using API snippets only")

                if batch:
                    await Actor.push_data(batch)

                with_desc = sum(1 for j in batch if j.get("description"))
                Actor.log.info(
                    f"[{keyword}] Done — {len(batch)} jobs pushed, "
                    f"{with_desc} with full descriptions"
                )
                grand_total += len(batch)

        Actor.log.info(f"Jooble scraper complete — {grand_total} total jobs")


asyncio.run(main())
