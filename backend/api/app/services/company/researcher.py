"""
Company research orchestration service — Phase 10.3.

Researches a company using:
  1. Tavily web search (if TAVILY_API_KEY is set) — structured results
  2. Direct website scraping (httpx + BeautifulSoup) — always attempted
  3. AI distillation (user's BYOK key) — structured CompanyFacts + VoiceSignals

Public API
----------
research_company(client, company_name, company_domain, tavily_api_key)
    → dict (serialised CompanyResearch, ready to write to Supabase)

Raises CompanyResearchError on unrecoverable failure.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Privacy note
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Company research text is public information (scraped from public websites).
No user data is sent to the AI in this call — only company_name and the
raw_research_text assembled from public sources.
The BYOK api_key is used only to authenticate the distillation call and
is never logged.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from bs4 import BeautifulSoup
from pydantic import ValidationError

from app.schemas.company import (
    CompanyFacts,
    CompanyResearch,
    HiringIntel,
    RecentEvent,
    VoiceSignals,
)
from app.services.ai.client import AIClient, AIClientError
from app.services.ai.prompts.cover_letter.company_research import (
    COMPANY_RESEARCH_SYSTEM,
    COMPANY_RESEARCH_USER_TEMPLATE,
)
from app.services.company.jd_geo import (
    country_full_name,
    detect_country,
    normalise_location,
)
from app.services.company.quality_scorer import compute_quality_score
from app.services.company.slug import make_company_slug
from app.security.ssrf import SSRFError, safe_get

logger = logging.getLogger(__name__)

_USER_AGENT = "Mozilla/5.0 (compatible; JobTrackrBot/1.0)"
_SCRAPE_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_TAVILY_TIMEOUT = httpx.Timeout(20.0, connect=5.0)
_TAVILY_API_URL = "https://api.tavily.com/search"

# Max chars of company HTML to parse (prevents runaway memory on large sites)
_MAX_COMPANY_HTML_CHARS = 8_000
# Max chars of combined research text sent to the model
_MAX_RESEARCH_CHARS = 15_000

_STRIP_TAGS = ("script", "style", "noscript", "svg", "iframe", "nav", "footer",
               "header", "aside", "form")

# 12 months in days — events older than this are flagged stale
_STALE_DAYS = 365


class CompanyResearchError(Exception):
    """Unrecoverable failure in the research pipeline."""


# ── Tavily search ─────────────────────────────────────────────────────────────

async def _tavily_search(
    company_name: str,
    tavily_api_key: str,
    jd_location: Optional[str] = None,
    jd_country_name: Optional[str] = None,
) -> tuple[list[dict], int]:
    """
    Run three Tavily searches for the company. Returns (results_list, count).
    results_list entries: {"title", "url", "content"} dicts from Tavily.

    When jd_location and/or jd_country_name are supplied, queries are biased
    toward the JD's geography — this disambiguates same-named organisations
    in different countries (e.g. AU Sanctuary Care vs. UK Sanctuary Group).
    """
    loc = (jd_location or "").strip()
    country = (jd_country_name or "").strip()
    # The geo suffix prefers location (more specific) over country, falling
    # back to country when location is empty, and to "" when both are absent.
    # An empty suffix reverts to the original (geographically-naive) query.
    geo_suffix = f" {loc}" if loc else (f" {country}" if country else "")
    country_suffix = f" {country}" if country else geo_suffix
    queries = [
        f"{company_name}{geo_suffix} official website",
        f'"{company_name}"{country_suffix} about mission',
        f"{company_name}{geo_suffix} careers team culture",
    ]
    all_results: list[dict] = []

    async with httpx.AsyncClient(timeout=_TAVILY_TIMEOUT) as client:
        for query in queries:
            try:
                resp = await client.post(
                    _TAVILY_API_URL,
                    json={
                        "api_key": tavily_api_key,
                        "query": query,
                        "search_depth": "basic",
                        "max_results": 3,
                        "include_answer": False,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    results = data.get("results") or []
                    for r in results:
                        all_results.append({
                            "title": r.get("title", ""),
                            "url": r.get("url", ""),
                            "content": r.get("content", ""),
                        })
            except Exception as exc:
                logger.warning("tavily search failed for query %r: %s", query, exc)

    logger.info(
        "tavily search: company=%r, queries=3, results=%d",
        company_name,
        len(all_results),
    )
    return all_results, len(all_results)


# ── Website scraping ──────────────────────────────────────────────────────────

def _infer_homepage_url(company_name: str, domain: Optional[str]) -> Optional[str]:
    """Return a best-effort homepage URL from a known domain, or None."""
    if domain:
        if not re.match(r"^https?://", domain):
            return f"https://{domain}"
        return domain
    return None


async def _scrape_homepage(url: str) -> str:
    """
    Fetch a company homepage and return cleaned text (up to _MAX_COMPANY_HTML_CHARS).
    Returns empty string on any failure — scraping is best-effort.
    """
    try:
        # follow_redirects=False so safe_get can SSRF-validate every hop.
        # company_domain is user-influenced, so this fetch must not be allowed
        # to reach internal/metadata addresses.
        async with httpx.AsyncClient(
            headers={"User-Agent": _USER_AGENT, "Accept": "text/html,*/*;q=0.8"},
            timeout=_SCRAPE_TIMEOUT,
            follow_redirects=False,
        ) as client:
            resp = await safe_get(client, url, max_redirects=3)
            if resp.status_code != 200:
                logger.info("homepage scrape: status=%d url=%s", resp.status_code, url)
                return ""
            soup = BeautifulSoup(resp.text, "html.parser")
            for tag in soup(_STRIP_TAGS):
                tag.decompose()
            text = soup.get_text(separator=" ", strip=True)
            text = re.sub(r"\s+", " ", text)
            return text[:_MAX_COMPANY_HTML_CHARS]
    except Exception as exc:
        logger.info("homepage scrape failed: url=%s error=%s", url, exc)
        return ""


# ── Research text assembly ────────────────────────────────────────────────────

def _assemble_research_text(
    tavily_results: list[dict],
    scraped_homepage: str,
    company_name: str,
) -> str:
    """Combine all collected text into a single string for the model."""
    parts: list[str] = []

    if scraped_homepage:
        parts.append(f"=== Company website (scraped) ===\n{scraped_homepage}")

    for i, r in enumerate(tavily_results[:5]):  # cap at 5 results
        content = r.get("content", "").strip()
        title = r.get("title", "")
        url = r.get("url", "")
        if content:
            parts.append(f"=== Search result {i + 1}: {title} ({url}) ===\n{content}")

    if not parts:
        parts.append(
            f"=== Fallback ===\n"
            f"No web content could be retrieved for {company_name}. "
            f"Return best-effort facts based on any general knowledge, "
            f"but mark distinguishing_facts as empty if nothing specific is known."
        )

    combined = "\n\n".join(parts)
    return combined[:_MAX_RESEARCH_CHARS]


# ── Staleness injection ───────────────────────────────────────────────────────

def _inject_stale_flags(events: list[RecentEvent]) -> list[RecentEvent]:
    """
    Set event.stale = True for events older than _STALE_DAYS or with no date.
    Mutates each RecentEvent in place (returns same list for convenience).
    """
    now = datetime.now(timezone.utc)
    for evt in events:
        if not evt.date:
            evt.stale = True
            continue
        try:
            parts = evt.date.split("-")
            year = int(parts[0])
            month = int(parts[1]) if len(parts) > 1 else 6
            day = int(parts[2]) if len(parts) > 2 else 15
            evt_dt = datetime(year, month, day, tzinfo=timezone.utc)
            if (now - evt_dt).days > _STALE_DAYS:
                evt.stale = True
        except (ValueError, IndexError):
            evt.stale = True
    return events


# ── Domain discovery ──────────────────────────────────────────────────────────

def _discover_domain(tavily_results: list[dict], company_domain: Optional[str]) -> Optional[str]:
    """
    Return the best available domain after research:
    - Prefer the caller-supplied domain.
    - Otherwise take the hostname of the first Tavily result URL that looks
      like a company homepage (not a news aggregator or LinkedIn).
    """
    if company_domain:
        return company_domain

    skip_hosts = {"linkedin.com", "glassdoor.com", "indeed.com", "seek.com.au",
                  "adzuna.com", "news.com.au", "bbc.com", "reuters.com",
                  "bloomberg.com", "techcrunch.com", "afr.com"}

    for r in tavily_results:
        url = r.get("url", "")
        m = re.match(r"https?://(?:www\.)?([^/]+)", url)
        if m:
            host = m.group(1).lower()
            root = ".".join(host.split(".")[-2:])
            if root not in skip_hosts:
                return host
    return None


# ── Main entry point ──────────────────────────────────────────────────────────

async def research_company(
    client: AIClient,
    company_name: str,
    company_domain: Optional[str],
    tavily_api_key: Optional[str],
    jd_location: Optional[str] = None,
) -> dict:
    """
    Research a company and return a dict ready for Supabase INSERT.

    Parameters
    ----------
    client : AIClient
        Configured with the triggering user's BYOK key.
    company_name : str
        Company name as it appears in the jobs table.
    company_domain : Optional[str]
        Domain hint if known (e.g. 'atlassian.com'). May be None.
    tavily_api_key : Optional[str]
        System-level Tavily key from env. If None/empty, search is skipped.
    jd_location : Optional[str]
        JD's job location (e.g. "Rouse Hill, Sydney NSW"). Used to bias
        search queries and to flag fact-text country mismatches downstream.
        None falls back to legacy geographically-naive behaviour.

    Returns
    -------
    dict
        Serialised CompanyResearch, ready for supabase.table('company_research').upsert().
    """
    company_id = make_company_slug(company_name)
    # Resolve JD geography (country code + human-readable country name +
    # cleaned location) once; pass downstream as needed.
    jd_country_code = detect_country(jd_location)
    jd_country_name = country_full_name(jd_country_code)
    cleaned_location = normalise_location(jd_location)
    logger.info(
        "research_company: company_id=%r name=%r jd_location=%r country=%s",
        company_id,
        company_name,
        cleaned_location,
        jd_country_code or "unknown",
    )

    # ── 1. Tavily search ───────────────────────────────────────────────────────
    search_skipped = False
    tavily_results: list[dict] = []
    sources_found = 0

    if tavily_api_key and tavily_api_key.strip():
        try:
            tavily_results, sources_found = await _tavily_search(
                company_name,
                tavily_api_key,
                jd_location=cleaned_location,
                jd_country_name=jd_country_name,
            )
        except Exception as exc:
            logger.warning("tavily search raised unexpectedly: %s", exc)
            search_skipped = True
    else:
        search_skipped = True
        logger.info("research_company: TAVILY_API_KEY absent — search skipped")

    # ── 2. Discover domain + scrape homepage ──────────────────────────────────
    discovered_domain = _discover_domain(tavily_results, company_domain)
    homepage_url = _infer_homepage_url(company_name, discovered_domain)

    scraped_text = ""
    if homepage_url:
        scraped_text = await _scrape_homepage(homepage_url)
        if scraped_text:
            logger.info(
                "research_company: homepage scraped: url=%s chars=%d",
                homepage_url,
                len(scraped_text),
            )

    # ── 3. Assemble research text ─────────────────────────────────────────────
    raw_research_text = _assemble_research_text(tavily_results, scraped_text, company_name)

    # ── 4. AI distillation ────────────────────────────────────────────────────
    # jd_location_block surfaces the JD's geography (city + country) to the
    # model so it can refuse to distill facts about a wrong-country org.
    # Renders as "Sydney NSW, Australia" when both known, or just one of them
    # when only one is, or "(not specified)" so the prompt still parses.
    if cleaned_location and jd_country_name:
        jd_location_block = f"{cleaned_location}, {jd_country_name}"
    elif cleaned_location:
        jd_location_block = cleaned_location
    elif jd_country_name:
        jd_location_block = jd_country_name
    else:
        jd_location_block = "(not specified)"
    user_prompt = COMPANY_RESEARCH_USER_TEMPLATE.format(
        company_name=company_name,
        jd_location_block=jd_location_block,
        raw_research_text=raw_research_text,
    )

    try:
        raw = await client.complete_json(
            system=COMPANY_RESEARCH_SYSTEM,
            user=user_prompt,
            max_tokens=2_000,
            temperature=0.1,
            no_training=True,
        )
    except AIClientError as exc:
        raise CompanyResearchError(
            f"AI distillation failed for company {company_id!r}: {exc}"
        ) from exc

    # ── 5. Pydantic validation ────────────────────────────────────────────────
    try:
        facts_raw = raw.get("facts", {})
        voice_raw = raw.get("voice_signals", {})
        hiring_raw = raw.get("hiring_intel", {})

        facts = CompanyFacts(**facts_raw)
        voice = VoiceSignals(**voice_raw)
        hiring = HiringIntel(**hiring_raw)
    except (ValidationError, TypeError) as exc:
        logger.error(
            "research_company: Pydantic validation failed for %r: %s",
            company_id,
            exc,
        )
        raise CompanyResearchError(
            f"Distillation response did not match expected schema for {company_id!r}. "
            "Check server logs."
        ) from exc

    # ── 6. Inject stale flags on RecentEvents ─────────────────────────────────
    facts.recent_events = _inject_stale_flags(facts.recent_events)

    # ── 7. Quality score ─────────────────────────────────────────────────────
    quality_score = compute_quality_score(
        sources_found=sources_found,
        sample_text=voice.sample_text,
        recent_events=[e.model_dump() for e in facts.recent_events],
    )

    # ── 8. Assemble final record ──────────────────────────────────────────────
    now = datetime.now(timezone.utc)
    research = CompanyResearch(
        company_id=company_id,
        name=company_name,
        domain=discovered_domain,
        last_researched_at=now,
        research_ttl_days=90,
        facts=facts,
        voice_signals=voice,
        hiring_intel=hiring,
        research_quality_score=quality_score,
        search_skipped=search_skipped,
    )

    logger.info(
        "research_company: completed company_id=%r quality=%.3f search_skipped=%s",
        company_id,
        quality_score,
        search_skipped,
    )

    return research.model_dump(mode="json")
