// Careerjet AU adapter — direct API listings + curl_cffi full JD enrichment.
// No Apify actor required.
//
// Two-phase design (mirrors SEEK's pattern):
//
//   Phase 1 — Listings (fetchJobs)
//     • GET https://search.api.careerjet.net/v4/query
//     • No Cloudflare — clean JSON response via gotScraping
//     • Returns RawJob[] with the API's 230-char excerpt as description
//
//   Phase 2 — Full JDs (enrichWithCareerjetJDs)
//     • GET https://www.careerjet.com.au/jobad/<hash>
//     • Cloudflare-protected — bypassed by Python curl_cffi subprocess
//       (Chrome 124 JA3/ALPN TLS impersonation). Optionally routes through
//       Apify residential AU proxy when APIFY_PROXY_PASSWORD is set (needed
//       from Fly's datacenter IP where IP-reputation check also fires).
//     • Replaces description with 5-14k char full text
//
// Auth model:
//   • API key in CAREERJET_API_KEY (Basic auth, password = "")
//   • Server outbound IP must be whitelisted at https://www.careerjet.com.au/
//     partners/api-config (up to 8 IPs per key — covers Fly multi-region).
//   • The `user_ip` query param is required by Careerjet for THEIR analytics
//     (not auth). We send the worker's own public IP, looked up once and
//     cached. Any valid public IP works.

import { gotScraping } from "got-scraping";
import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import type { NormalisedJob } from "../pipeline/types.js";
import { getApifyProxyUrl, hasApifyProxy } from "../lib/proxy.js";
import { curlFetch, curlRedirect } from "../lib/curlfetch.js";

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE        = "https://search.api.careerjet.net/v4/query";
const REFERER         = "https://jobtrackr-cv.vercel.app/";
const USER_AGENT      = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PAGE_SIZE       = 50;             // Careerjet supports up to 100
const MAX_PAGES       = 4;              // → up to 200 jobs per keyword (incremental)
const FIRST_RUN_MAX_PAGES = 6;          // → up to 300 jobs per keyword (cold start)
const REQUEST_TIMEOUT = 15_000;
const KEYWORD_DELAY   = 800;            // gentle pacing between keywords
const JD_DELAY        = 600;            // pacing between /jobad/ fetches
const JD_FETCH_CAP    = 20;             // matches seek.ts SEEK_JD_FETCH_CAP

// Public IP cache — Careerjet wants a real IP in `user_ip`. We fetch ours
// once per worker process and reuse it (Fly outbound IP is stable per region).
let cachedPublicIp: string | null = null;
async function getPublicIp(): Promise<string> {
  if (cachedPublicIp) return cachedPublicIp;
  try {
    const res = await gotScraping({
      url:     "https://api.ipify.org",
      timeout: { request: 5_000 },
      retry:   { limit: 0 },
      throwHttpErrors: false,
    });
    const ip = String(res.body ?? "").trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      cachedPublicIp = ip;
      console.log(`[careerjet] public IP cached: ${ip}`);
      return ip;
    }
  } catch {
    // fall through
  }
  // Fallback: use a known-good public AU IP. Careerjet only logs this — it
  // does NOT affect authorization, so the call still succeeds.
  cachedPublicIp = "1.1.1.1";
  return cachedPublicIp;
}

// ── API types ─────────────────────────────────────────────────────────────────
interface CareerjetJob {
  title:       string;
  company?:    string;
  date?:       string;             // RFC 2822 string
  description?: string;            // ~230-500 char excerpt with <b> HTML tags
  locations?:  string;             // "Sydney, NSW" or "Sydney, NSW - Melbourne, VIC"
  salary?:     string;             // optional, formatted "AU$X-Y per year"
  salary_min?: number;
  salary_max?: number;
  salary_type?: "Y" | "M" | "W" | "D" | "H";
  salary_currency_code?: string;
  site?:       string;             // original source domain
  url:         string;             // https://jobviewtrack.com/v2/<hash>
}

interface CareerjetApiResponse {
  type?:     "JOBS" | "LOCATIONS" | "ERROR";
  hits?:     number;
  pages?:    number;
  jobs?:     CareerjetJob[];
  error?:    string;
  message?:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip HTML tags + entities from Careerjet's snippet field. */
function cleanText(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
}

/**
 * Careerjet's `locations` field is "Sydney, NSW" or "Sydney, NSW - Melbourne, VIC".
 * Keep just the primary city — dedup needs single-city values for the bucket key.
 */
function primaryLocation(locations: string | undefined, profileLocation: string): string {
  if (!locations) return profileLocation;
  // Split on " - " (multi-city) and take first
  return locations.split(" - ")[0].trim() || profileLocation;
}

/**
 * Normalize location for Careerjet API. The free-text `location` param is
 * forgiving — "Sydney", "Sydney NSW", "Sydney, NSW" all work.
 *
 * Empty / "All Australia" must NOT be sent — Careerjet then defaults to
 * country-wide which is what we want for AU-only profiles.
 */
function apiLocation(profileLocation: string): string {
  const trimmed = profileLocation.trim();
  if (!trimmed) return "";
  const low = trimmed.toLowerCase();
  if (low === "australia" || low === "all australia") return "";
  return trimmed;
}

/** Translate a single API job into our RawJob shape. */
function jobToRaw(job: CareerjetJob, keyword: string, profile: SearchProfile): RawJob | null {
  if (!job.title || !job.url) return null;

  // Convert RFC 2822 date string to ISO if possible.
  let posted_at: string | null = null;
  if (job.date) {
    const d = new Date(job.date);
    if (!isNaN(d.getTime())) posted_at = d.toISOString();
  }

  // Salary normalization — Careerjet returns min/max + a `salary_type` letter.
  // RawJob expects annual figures so the existing winner.ts scoring works.
  let salary_min: number | undefined;
  let salary_max: number | undefined;
  if (typeof job.salary_min === "number" && typeof job.salary_max === "number") {
    const scale =
      job.salary_type === "H" ? 2080 :   // hourly → annual (40h × 52w)
      job.salary_type === "D" ? 260  :   // daily  → annual (5d × 52w)
      job.salary_type === "W" ? 52   :   // weekly → annual
      job.salary_type === "M" ? 12   :   // monthly→ annual
      1;                                  // "Y" / default
    salary_min = Math.round(job.salary_min * scale);
    salary_max = Math.round(job.salary_max * scale);
  }

  return {
    url:         job.url,            // jobviewtrack.com tracking URL (stable per job)
    title:       job.title,
    company:     job.company ?? "",
    location:    primaryLocation(job.locations, profile.location),
    description: cleanText(job.description),
    source:      "careerjet",
    source_tier: 1,
    posted_at,
    expires_at:  null,
    ...(salary_min !== undefined && { salary_min }),
    ...(salary_max !== undefined && { salary_max }),
    raw:         { ...job, _keyword: keyword },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve a jobviewtrack.com tracking URL to the real job URL.
 *
 * jobviewtrack.com tracking URLs expire in ~1-2 minutes (one-time-use tokens).
 * We resolve them immediately after the API call — before they expire — using
 * a lightweight redirect-only fetch (no body, no Cloudflare bypass needed).
 *
 * Returns the original URL unchanged if resolution fails (expired, blocked,
 * or non-tracking URL).
 */
async function resolveTrackingUrl(trackingUrl: string): Promise<string> {
  if (!trackingUrl.includes("jobviewtrack.com")) return trackingUrl;
  try {
    // redirect: "manual" gets us the 302 Location without following the chain
    const res = await fetch(trackingUrl, {
      method:   "GET",
      redirect: "manual",
      headers:  { "User-Agent": USER_AGENT, "Accept": "text/html" },
      signal:   AbortSignal.timeout(8_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) return loc;
    }
    // 404 / other — tracking URL already expired or IP-blocked
  } catch {
    // timeout or network error — return original
  }
  return trackingUrl;
}

/**
 * Resolve tracking URLs for a batch of jobs in parallel (max 5 concurrent).
 * Called immediately after each API page is fetched while URLs are fresh.
 */
async function resolveTrackingUrls(jobs: RawJob[]): Promise<RawJob[]> {
  const CONCURRENCY = 5;
  const out = [...jobs];

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (job, bi) => {
        const realUrl = await resolveTrackingUrl(job.url);
        if (realUrl !== job.url) {
          out[i + bi] = {
            ...job,
            url: realUrl,
            // Keep original tracking URL in raw for debugging
            raw: { ...(job.raw as object ?? {}), _tracking_url: job.url },
          };
        }
      }),
    );
  }

  return out;
}

async function fetchPage(
  apiKey:   string,
  keyword:  string,
  location: string,
  page:     number,
  userIp:   string,
): Promise<CareerjetApiResponse> {
  const params = new URLSearchParams({
    locale_code:   "en_AU",
    keywords:      keyword,
    location,
    sort:          "date",
    page:          String(page),
    // Careerjet API uses `pagesize` (no underscore). Sending `page_size`
    // silently falls back to their default of 20 results — was capping every
    // run at 20 jobs/page instead of the intended 50.
    pagesize:      String(PAGE_SIZE),
    user_ip:       userIp,
    user_agent:    USER_AGENT,
  });

  // Basic auth: api_key:""  (per Careerjet docs).
  const authHeader = "Basic " + Buffer.from(`${apiKey}:`).toString("base64");

  const res = await gotScraping({
    url:     `${API_BASE}?${params.toString()}`,
    method:  "GET",
    timeout: { request: REQUEST_TIMEOUT },
    retry:   { limit: 1, methods: ["GET"] },
    headers: {
      "Authorization": authHeader,
      "Referer":       REFERER,
      "Accept":        "application/json",
    },
    throwHttpErrors: false,
    // NOTE: no proxyUrl here — the API endpoint is IP-whitelisted, so we
    // must call it from Fly's actual outbound IP, not a residential proxy.
  });

  if (res.statusCode !== 200) {
    throw new Error(`Careerjet API HTTP ${res.statusCode}: ${String(res.body ?? "").slice(0, 300)}`);
  }
  return JSON.parse(String(res.body)) as CareerjetApiResponse;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const careerjetAdapter: SourceAdapter = {
  name:           "careerjet",
  tier:           1,
  vertical:       "general",
  rateLimitDelay: 1000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const apiKey = process.env.CAREERJET_API_KEY;
    if (!apiKey) {
      throw new Error("CAREERJET_API_KEY is required");
    }

    const userIp   = await getPublicIp();
    const location = apiLocation(profile.location);

    console.log(
      `[careerjet] keywords: ${profile.keywords.join(", ")} · ` +
      `location: ${location || "(AU-wide)"} · user_ip: ${userIp}`,
    );

    const allJobs: RawJob[] = [];
    const seenUrls = new Set<string>();

    // Careerjet has no date filter, so we lean on sort=date (newest first) +
    // dedup. First run goes deeper; incremental runs stay shallow.
    const maxPages = profile.is_first_run ? FIRST_RUN_MAX_PAGES : MAX_PAGES;

    for (let i = 0; i < profile.keywords.length; i++) {
      const keyword = profile.keywords[i].trim();
      if (!keyword) continue;

      let keywordCount = 0;
      let totalPages = maxPages;

      for (let page = 1; page <= totalPages; page++) {
        let body: CareerjetApiResponse;
        try {
          body = await fetchPage(apiKey, keyword, location, page, userIp);
        } catch (err) {
          console.error(`[careerjet] "${keyword}" page ${page} error: ${err instanceof Error ? err.message : err}`);
          break;
        }

        if (body.type === "ERROR") {
          throw new Error(`Careerjet API error: ${body.error ?? body.message ?? "unknown"}`);
        }
        if (body.type === "LOCATIONS") {
          // Ambiguous location — log and skip (rare, but documented behaviour).
          console.warn(`[careerjet] "${keyword}": ${body.message} — skipping`);
          break;
        }

        const jobs    = body.jobs ?? [];
        const reported = body.pages ?? 1;
        totalPages = Math.min(maxPages, reported);

        if (jobs.length === 0) break;

        // Build RawJobs from the API response (still with tracking URLs)
        const pageRaws: RawJob[] = [];
        for (const job of jobs) {
          if (seenUrls.has(job.url)) continue;
          const raw = jobToRaw(job, keyword, profile);
          if (!raw) continue;
          seenUrls.add(job.url);
          pageRaws.push(raw);
        }

        // Immediately resolve jobviewtrack.com tracking URLs → real job URLs.
        // Must happen before returning so users get clickable links in the UI.
        // Uses parallel native fetch (5 concurrent); expires in ~1-2 min so timing matters.
        const resolvedRaws = await resolveTrackingUrls(pageRaws);
        const resolvedCount = resolvedRaws.filter(
          (r, i) => r.url !== pageRaws[i].url,
        ).length;

        let pageAdded = 0;
        for (const raw of resolvedRaws) {
          allJobs.push(raw);
          keywordCount++;
          pageAdded++;
        }

        console.log(
          `[careerjet] "${keyword}" page ${page}/${totalPages}: ` +
          `added ${pageAdded} (${resolvedCount} URLs resolved), ` +
          `kw total ${keywordCount}, all total ${allJobs.length} ` +
          `(hits=${body.hits ?? "?"})`,
        );

        if (jobs.length < PAGE_SIZE) break;
        if (page < totalPages) await sleep(this.rateLimitDelay);
      }

      if (i < profile.keywords.length - 1) await sleep(KEYWORD_DELAY);
    }

    console.log(`[careerjet] done — ${allJobs.length} unique jobs across ${profile.keywords.length} keyword(s)`);
    return allJobs;
  },

  async isHealthy(): Promise<boolean> {
    const apiKey = process.env.CAREERJET_API_KEY;
    if (!apiKey) return false;
    try {
      const ip = await getPublicIp();
      const body = await fetchPage(apiKey, "analyst", "Sydney", 1, ip);
      return Array.isArray(body.jobs);
    } catch {
      return false;
    }
  },
};

// ── Phase 2: Full JD enrichment ───────────────────────────────────────────────
//
// The Careerjet API returns jobviewtrack.com/v2/<hash> tracking URLs.
// jobviewtrack.com is a separate tracking domain that:
//   1. Logs the click for Careerjet analytics
//   2. 302 redirects to the actual job page (careerjet.com.au/jobad/<hash>
//      for native Careerjet listings, or the employer's site otherwise)
//
// From Fly's datacenter IP, jobviewtrack.com returns 404 (its own bot
// protection, separate from Cloudflare). The strategy is:
//   - First fetch the tracking URL with curl_cffi; if it 404s, skip.
//   - If it redirects to careerjet.com.au, extract the description there.
//   - If it redirects elsewhere (employer site), skip (structure unknown).
//
// curl_cffi is used because careerjet.com.au /jobad/ pages are Cloudflare-
// protected (Chrome 124 TLS impersonation bypasses the fingerprint check).

const CAREERJET_HOST = "www.careerjet.com.au";

/**
 * Fetch the full HTML of a Careerjet job page.
 *
 * By Phase 2 (Stage 7c), tracking URLs have already been resolved to real URLs
 * in Phase 1 (`resolveTrackingUrls`). So `url` here should be either:
 *   • careerjet.com.au/jobad/<hash>  → Cloudflare-protected, curl_cffi handles it
 *   • An employer's own website       → skip (unknown page structure)
 *   • A fallback jobviewtrack.com URL → skip (expired, can't enrich)
 *
 * Returns null for non-Careerjet pages and tracking URLs.
 */
async function fetchJobadHtml(
  url: string,
): Promise<{ status: number; body: string; finalUrl: string } | null> {
  // Only fetch careerjet.com.au pages — we have an extractor for those.
  // Employer sites and expired tracking URLs are skipped silently.
  try {
    const { hostname } = new URL(url);
    if (hostname === "jobviewtrack.com") {
      // Phase 1 resolution failed — URL never got resolved, skip it
      return null;
    }
    if (hostname !== CAREERJET_HOST) {
      // Resolved to an employer site — we don't know its page structure
      return null;
    }
  } catch {
    return null;
  }

  const proxyUrl = getApifyProxyUrl({ group: "RESIDENTIAL", country: "AU" });
  const result = await curlFetch(url, proxyUrl);
  if (result.status !== 200) return null;
  return { status: result.status, body: result.body, finalUrl: url };
}

/**
 * Careerjet's /jobad/ page wraps the full description in `<div class="container">`
 * before a `<div class="links">|<div class="off">|<div class="footer">` block.
 */
function extractJobadDescription(html: string): string {
  const m = html.match(
    /<div[^>]+class="container"[^>]*>([\s\S]+?)<\/div>\s*<div[^>]+class="(?:links|off|footer)/,
  );
  if (!m) return "";

  const text = m[1]
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi,   " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/\s+/g, " ")
    .trim();

  // Strip the page header (title/company/location/date repeated above the body).
  // Heuristic: drop everything before the first "Job Description" marker if
  // present; otherwise drop the first ~150 chars of nav prefix.
  const jobDescMatch = text.match(/job description[:\s]*/i);
  if (jobDescMatch && jobDescMatch.index !== undefined) {
    return text.slice(jobDescMatch.index + jobDescMatch[0].length).trim();
  }
  return text;
}

export const CAREERJET_JD_FETCH_CAP = JD_FETCH_CAP;

export async function enrichWithCareerjetJDs(
  jobs: NormalisedJob[],
  cap:  number = JD_FETCH_CAP,
): Promise<{ jobs: NormalisedJob[]; costUsd: number; merged: number; fetched: number }> {
  const targets = jobs.filter((j) => j.source === "careerjet" && j.url).slice(0, cap);
  if (targets.length === 0) {
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  console.log(
    `[careerjet-jd] enriching ${targets.length} Careerjet survivors (cap ${cap})` +
    ` · curl_cffi` +
    (hasApifyProxy() ? " + Apify residential proxy" : " direct (no proxy)"),
  );

  // Count how many targets actually point to careerjet.com.au (resolved in Phase 1)
  const careerjetTargets = targets.filter((j) => {
    try { return new URL(j.url).hostname === CAREERJET_HOST; } catch { return false; }
  });

  if (careerjetTargets.length === 0) {
    console.log(`[careerjet-jd] no careerjet.com.au URLs to enrich (Phase 1 resolution failed or all employer sites)`);
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  console.log(
    `[careerjet-jd] enriching ${careerjetTargets.length}/${targets.length} careerjet.com.au survivors` +
    ` · curl_cffi` +
    (hasApifyProxy() ? " + Apify residential proxy" : " direct (no proxy)"),
  );

  const descByUrl = new Map<string, string>();
  let attempted = 0;

  for (const job of careerjetTargets) {
    attempted++;
    try {
      const result = await fetchJobadHtml(job.url);
      if (!result) continue;
      const desc = extractJobadDescription(result.body);
      if (desc.length > 200) {
        descByUrl.set(job.url, desc);
        console.log(`[careerjet-jd] ${result.finalUrl}: ${desc.length} chars ✓`);
      } else {
        console.warn(`[careerjet-jd] ${result.finalUrl}: extracted only ${desc.length} chars`);
      }
    } catch (err) {
      console.warn(`[careerjet-jd] ${job.url}: ${err instanceof Error ? err.message : err}`);
    }
    if (attempted < careerjetTargets.length) await sleep(JD_DELAY);
  }

  let merged = 0;
  const out = jobs.map((j) => {
    const full = descByUrl.get(j.url);
    if (full) { merged++; return { ...j, description: full }; }
    return j;
  });

  console.log(`[careerjet-jd] merged ${merged}/${targets.length} full descriptions`);
  return { jobs: out, costUsd: 0, merged, fetched: targets.length };
}
