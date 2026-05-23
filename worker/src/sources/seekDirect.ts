// SEEK AU adapter — direct HTML scraping via Python curl_cffi. No Apify required.
//
// Architecture: SEEK server-renders the entire job-search response into
// `window.SEEK_REDUX_DATA = {...}` inside the HTML page. Python curl_cffi's
// Chrome 124 TLS impersonation bypasses Cloudflare's bot detection. One GET
// per page returns 22 jobs.
//
// This adapter is the PRIMARY SEEK source. The existing Apify-based
// `createSeekAdapter` in seek.ts remains as an automatic fallback —
// the orchestrator only runs it if this adapter throws.
//
// Output fields mirror seek.ts exactly so dedup/winner scoring works
// identically whichever path produced the job.
//
// Cost: zero (no API/proxy). Risk: SEEK can change bot-defence rules
// any time. That's why we keep the Apify path wired in.
//
// Full JD enrichment lives in `enrichWithDirectJDs` (mirrors the actor's
// enrichWithFullJDs shape). Orchestrator picks the right enrich function
// based on which fetch path produced the SEEK jobs in this run.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import type { NormalisedJob } from "../pipeline/types.js";
import { getApifyProxyUrl, hasApifyProxy } from "../lib/proxy.js";
import { curlFetch } from "../lib/curlfetch.js";

// Match seek.ts cap so behaviour is interchangeable.
export const SEEK_DIRECT_JD_FETCH_CAP = 20;

// One page returns 22 jobs. We cap per-keyword to ~9 pages for safety.
const PAGE_SIZE = 22;
const MAX_PAGES_PER_KEYWORD = 9;       // → up to ~200 jobs per keyword
const MAX_JOBS_PER_KEYWORD  = 200;     // hard cap (matches actor maxResults)
const DATE_RANGE_DAYS       = 14;      // fallback when the orchestrator sets no window
// SEEK's daterange only accepts these values. Map our lookback to the smallest
// allowed value that still covers it (never under-fetch), capped at 31.
const SEEK_ALLOWED_DATERANGES = [1, 3, 7, 14, 31];
function seekDateRange(days: number): number {
  return SEEK_ALLOWED_DATERANGES.find((d) => d >= days) ?? 31;
}
const REQUEST_TIMEOUT_MS    = 25_000;
const PAGE_DELAY_MS         = 800;     // gentle pacing between pages
const JD_DELAY_MS           = 400;     // gentle pacing between JD pages

// Inside SEEK_REDUX_DATA.results.results.jobs[*]
interface ReduxJob {
  id:            string;
  title:         string;
  companyName?:  string;
  advertiser?:   { id?: string; description?: string };
  isFeatured?:   boolean;
  locations?:    Array<{
    countryCode?: string;
    label?:       string;
    seoHierarchy?: Array<{ contextualName?: string }>;
  }>;
  listingDate?:  string;
  salaryLabel?:  string | null;
  teaser?:       string;
  workTypes?:    string[];
}

interface ReduxData {
  results?: {
    results?: {
      jobs?: ReduxJob[];
      totalCount?: number;
    };
  };
  jobdetails?: {
    result?: {
      job?: {
        content?: string;
        title?: string;
      };
    };
  };
}

function extractRedux(html: string): ReduxData | null {
  const m = html.match(
    /window\.SEEK_REDUX_DATA\s*=\s*(\{[\s\S]+?\});\s*(?:<\/script>|window\.)/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as ReduxData;
  } catch {
    return null;
  }
}

function parseSalary(text: string | undefined | null): { salary_min?: number; salary_max?: number } {
  if (!text) return {};
  const nums = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return {};
  const isHourly = /per hour|hourly|\/hr/i.test(text);
  const [lo, hi] = nums;
  const scale = isHourly ? 2080 : 1;
  return {
    salary_min: lo ? lo * scale : undefined,
    salary_max: (hi ?? lo) * scale,
  };
}

/**
 * Normalise a user-entered profile location to what SEEK's `where` param
 * accepts. SEEK understands city names ("Sydney NSW"), state names
 * ("New South Wales"), and state codes ("NSW") but chokes on the
 * ", Australia" suffix users sometimes append.
 *
 * Returns empty string for AU-wide searches (no `where` param).
 */
function normaliseSeekLocation(raw: string): string {
  let loc = raw.trim();
  // Strip trailing ", Australia" or " Australia" (case-insensitive)
  loc = loc.replace(/,?\s*australia$/i, "").trim();
  const low = loc.toLowerCase();
  if (!low || low === "australia" || low === "all australia") return "";
  return loc;
}

function buildSearchUrl(keyword: string, location: string, page: number, dateRange: number): string {
  const params = new URLSearchParams({
    keywords:  keyword,
    sortmode:  "ListedDate",
    page:      String(page),
    daterange: String(dateRange),
  });
  const where = normaliseSeekLocation(location);
  if (where) params.set("where", where);
  return `https://www.seek.com.au/jobs?${params.toString()}`;
}

/**
 * Pick a fresh AU residential proxy URL for each call.
 *
 * Why per-call (not per-module): Apify rotates the exit IP whenever a new
 * proxy session is opened with `username = "auto,..."`, so building a new URL
 * per request gets us a different residential IP for each page — much harder
 * for Cloudflare to fingerprint than reusing the same one.
 *
 * Returns undefined when APIFY_PROXY_PASSWORD is not configured, so local
 * dev (laptop on residential ISP) still works direct.
 */
function seekProxyUrl(): string | undefined {
  return getApifyProxyUrl({ group: "RESIDENTIAL", country: "AU" });
}

/**
 * Fetch a SEEK page using Python curl_cffi (Chrome 124 TLS impersonation).
 *
 * curl_cffi replaced got-scraping here because Cloudflare detects got-scraping's
 * TLS fingerprint from Fly's datacenter IP even when routing through a
 * residential proxy. curl_cffi's Chrome 124 JA3/ALPN fingerprint is not
 * detectable regardless of the exit IP.
 *
 * Proxy routing: when APIFY_PROXY_PASSWORD is set the request is additionally
 * routed through an Apify residential AU IP (bypassing Cloudflare's
 * IP-reputation block for datacenter IPs). Without it the request goes direct
 * — fine for local dev on a residential ISP.
 */
async function fetchHtml(url: string): Promise<{ status: number; body: string }> {
  const proxyUrl = seekProxyUrl();
  return curlFetch(url, proxyUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jobToRaw(job: ReduxJob, profile: SearchProfile): RawJob | null {
  if (!job.id || !job.title) return null;

  const url = `https://www.seek.com.au/job/${job.id}`;
  const company = job.companyName ?? job.advertiser?.description ?? "";
  const primaryLocation = job.locations?.[0];
  const locationLabel =
    primaryLocation?.label
    ?? primaryLocation?.seoHierarchy?.[0]?.contextualName
    ?? profile.location;
  const description = job.teaser ?? "";
  const posted_at = job.listingDate
    ? (() => { try { return new Date(job.listingDate!).toISOString(); } catch { return null; } })()
    : null;
  const { salary_min, salary_max } = parseSalary(job.salaryLabel);

  return {
    url,
    title:       job.title,
    company,
    location:    locationLabel,
    description,
    source:      "seek",
    source_tier: 1,
    posted_at,
    expires_at:  null,
    ...(salary_min !== undefined && { salary_min }),
    ...(salary_max !== undefined && { salary_max }),
    raw:         job,
  };
}

export const seekDirectAdapter: SourceAdapter = {
  name:           "seek",
  tier:           1,
  vertical:       "general",
  rateLimitDelay: 1500,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();
    let featuredSkipped = 0;
    let firstHardError: Error | null = null;
    let anyPageSucceeded = false;

    console.log(
      `[seek-direct] keywords: ${profile.keywords.join(", ")} · location: "${profile.location}"` +
      ` · curl_cffi` +
      (hasApifyProxy() ? " + Apify residential proxy" : " direct (no proxy)"),
    );

    // Window the search to the orchestrator's lookback (28 on first run → 31;
    // small on incremental runs), mapped to SEEK's allowed daterange values.
    const dateRange = seekDateRange(profile.lookback_days ?? DATE_RANGE_DAYS);

    for (const keyword of profile.keywords) {
      let keywordCount = 0;
      let totalPages = MAX_PAGES_PER_KEYWORD;

      for (let page = 1; page <= totalPages && keywordCount < MAX_JOBS_PER_KEYWORD; page++) {
        const url = buildSearchUrl(keyword, profile.location, page, dateRange);
        let status = 0;
        let body = "";

        try {
          ({ status, body } = await fetchHtml(url));
        } catch (err) {
          firstHardError ??= err instanceof Error ? err : new Error(String(err));
          console.warn(`[seek-direct] ${keyword} page ${page}: fetch threw — ${firstHardError.message}`);
          break;
        }

        if (status !== 200) {
          firstHardError ??= new Error(`SEEK returned HTTP ${status} for ${keyword} page ${page}`);
          console.warn(`[seek-direct] ${keyword} page ${page}: HTTP ${status}`);
          break;
        }

        const redux = extractRedux(body);
        const jobs = redux?.results?.results?.jobs;
        if (!redux || !jobs) {
          firstHardError ??= new Error(`SEEK_REDUX_DATA missing or malformed (page ${page})`);
          console.warn(`[seek-direct] ${keyword} page ${page}: SEEK_REDUX_DATA missing`);
          break;
        }

        anyPageSucceeded = true;

        const totalCount = redux.results?.results?.totalCount ?? 0;
        totalPages = Math.min(MAX_PAGES_PER_KEYWORD, Math.max(1, Math.ceil(totalCount / PAGE_SIZE)));

        let pageAdded = 0;
        for (const job of jobs) {
          if (job.isFeatured) { featuredSkipped++; continue; }
          if (!job.id || seenIds.has(job.id)) continue;
          if (keywordCount >= MAX_JOBS_PER_KEYWORD) break;

          const raw = jobToRaw(job, profile);
          if (!raw) continue;
          allJobs.push(raw);
          seenIds.add(job.id);
          keywordCount++;
          pageAdded++;
        }

        console.log(
          `[seek-direct] ${keyword} page ${page}/${totalPages}: added ${pageAdded}, kw total ${keywordCount}, all total ${allJobs.length}`,
        );

        // Last page heuristic: SEEK page returned fewer than a full set OR we've
        // hit our cap.
        if (jobs.length < PAGE_SIZE) break;
        if (page < totalPages) await sleep(PAGE_DELAY_MS);
      }
    }

    if (featuredSkipped > 0) {
      console.log(`[seek-direct] skipped ${featuredSkipped} featured listings`);
    }

    // If every keyword failed before producing a single job AND we have a
    // recorded hard error, throw so the orchestrator triggers the actor
    // fallback. "0 jobs but every page returned 200" is a legitimate result
    // (small market with no listings) and must NOT trigger fallback.
    if (!anyPageSucceeded && firstHardError) {
      throw firstHardError;
    }

    console.log(`[seek-direct] done — ${allJobs.length} jobs`);
    return allJobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { status } = await fetchHtml("https://www.seek.com.au/data-analyst-jobs?page=1");
      return status === 200;
    } catch {
      return false;
    }
  },
};

// ── Full JD enrichment ────────────────────────────────────────────────────────
/**
 * Fetch full job descriptions for SEEK survivors via direct HTML scraping
 * of /job/<id> pages. Mirrors enrichWithFullJDs from seek.ts so the
 * orchestrator can swap call sites cleanly.
 *
 * Returns the same shape (with costUsd = 0 — this path is free).
 */
export async function enrichWithDirectJDs(
  jobs: NormalisedJob[],
  cap:  number = SEEK_DIRECT_JD_FETCH_CAP,
): Promise<{ jobs: NormalisedJob[]; costUsd: number; merged: number; fetched: number }> {
  const seekJobs = jobs.filter((j) => j.source === "seek" && j.url);
  const targets  = seekJobs.slice(0, cap);

  if (targets.length === 0) {
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  console.log(`[seek-direct-jd] enriching ${targets.length} SEEK survivors (cap ${cap})`);

  const descByUrl = new Map<string, string>();
  let attempted = 0;

  for (const job of targets) {
    attempted++;
    try {
      const { status, body } = await fetchHtml(job.url);
      if (status !== 200) {
        console.warn(`[seek-direct-jd] ${job.url}: HTTP ${status}`);
        continue;
      }
      const redux = extractRedux(body);
      const content = redux?.jobdetails?.result?.job?.content;
      if (content && content.length > 0) {
        // Strip HTML tags & decode minimal entities — downstream stages expect
        // plain text descriptions.
        const text = content
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > 0) descByUrl.set(job.url, text);
      }
    } catch (err) {
      console.warn(`[seek-direct-jd] ${job.url}: ${err instanceof Error ? err.message : err}`);
    }
    if (attempted < targets.length) await sleep(JD_DELAY_MS);
  }

  let merged = 0;
  const out = jobs.map((j) => {
    const full = descByUrl.get(j.url);
    if (full) { merged++; return { ...j, description: full }; }
    return j;
  });

  console.log(`[seek-direct-jd] merged ${merged}/${targets.length} full descriptions`);
  return { jobs: out, costUsd: 0, merged, fetched: targets.length };
}
