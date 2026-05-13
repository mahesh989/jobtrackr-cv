"""Fetch a job posting URL and extract clean JD text + best-effort job title.

Deliberately simple: a single GET, strip non-content tags, prefer the most
content-y container, normalise whitespace. No JS rendering — pages that require
client-side hydration to show the JD will return little text and surface a
clear error to the user.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_USER_AGENT = "Mozilla/5.0 (compatible; CVMagicBot/1.0; +https://cvmagic.app)"
_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_MAX_BYTES = 2 * 1024 * 1024  # 2 MB safety cap on downloaded HTML
_STRIP_TAGS = (
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "nav",
    "footer",
    "header",
    "aside",
    "form",
)
_MIN_TEXT_LEN = 200
_MAX_TEXT_LEN = 20_000


class JDScrapeError(Exception):
    """Recoverable scraping failure surfaced to the API caller."""


@dataclass
class ScrapedJD:
    jd_text: str
    job_title: Optional[str]
    source_url: str


async def scrape_jd(url: str) -> ScrapedJD:
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise JDScrapeError("URL must start with http:// or https://")

    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": _USER_AGENT, "Accept": "text/html,*/*;q=0.8"},
            timeout=_TIMEOUT,
            follow_redirects=True,
            max_redirects=5,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            if "html" not in content_type.lower():
                raise JDScrapeError(f"Unsupported content-type: {content_type}")
            raw = resp.content[:_MAX_BYTES]
            html = raw.decode(resp.encoding or "utf-8", errors="ignore")
            final_url = str(resp.url)
    except httpx.HTTPError as e:
        logger.warning("JD scrape HTTP error for %s: %s", url, e)
        raise JDScrapeError(f"Failed to fetch URL: {e}") from e

    soup = BeautifulSoup(html, "lxml")

    # ----- Title heuristic ----------------------------------------------------
    job_title: Optional[str] = None
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        job_title = og["content"].strip()
    elif soup.title and soup.title.string:
        job_title = soup.title.string.strip()
    elif soup.h1:
        job_title = soup.h1.get_text(strip=True)
    if job_title:
        # Common pattern: "Senior Engineer - Acme Corp" — keep just the title half
        for sep in (" | ", " - ", " – ", " · ", " at "):
            if sep in job_title:
                job_title = job_title.split(sep, 1)[0].strip()
                break

    # ----- Content extraction -------------------------------------------------
    for tag in soup(_STRIP_TAGS):
        tag.decompose()

    container = soup.find("main") or soup.find("article") or soup.body or soup
    text = container.get_text(separator="\n", strip=True)

    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)

    if len(text) < _MIN_TEXT_LEN:
        raise JDScrapeError(
            "Page contained too little text to be a job description "
            "(it may require JavaScript or login)"
        )

    if len(text) > _MAX_TEXT_LEN:
        text = text[:_MAX_TEXT_LEN]

    return ScrapedJD(jd_text=text, job_title=job_title, source_url=final_url)
