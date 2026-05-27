import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import type { NormalisedJob } from "../pipeline/types.js";
import * as cheerio from "cheerio";
import { curlFetch } from "../lib/curlfetch.js";

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;
const BASE = "https://api.adzuna.com/v1/api/jobs/au/search";
const RESULTS_PER_PAGE = 50;
const MAX_PAGES = 4;            // 200 results per keyword — incremental runs
const FIRST_RUN_MAX_PAGES = 10; // 500 results per keyword — one-off deep cold start

interface AdzunaResult {
  id: string;
  title: string;
  redirect_url: string;
  description: string;
  created: string;
  company?: { display_name: string };
  location?: { display_name: string };
  contract_time?: string;
  contract_type?: string;
  salary_min?: number;
  salary_max?: number;
}

interface AdzunaResponse {
  results: AdzunaResult[];
  count: number;
}

/**
 * Normalize location — Adzuna works best with city name only.
 * "Sydney NSW" → "Sydney", "Melbourne, VIC" → "Melbourne"
 */
function normalizeLocation(location: string): string {
  return location.split(/[,\s]+/)[0].trim() || "Australia";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(params: URLSearchParams, page: number): Promise<AdzunaResult[]> {
  const url = `${BASE}/${page}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Adzuna HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as AdzunaResponse;
  // Log the API-reported total once per page-1 call so the source-eval beta
  // can show "API says N match, we fetched M". `count` reflects all matches
  // ignoring pagination — very different from `results.length`.
  if (page === 1 && typeof body.count === "number") {
    console.log(`[adzuna] api reports total count=${body.count}`);
  }
  return body.results ?? [];
}

function mapToRawJob(r: AdzunaResult): RawJob {
  return {
    url: r.redirect_url,
    title: r.title,
    company: r.company?.display_name ?? "",
    location: r.location?.display_name ?? "",
    description: r.description ?? "",
    source: "adzuna",
    source_tier: 1,
    posted_at: r.created ?? null,
    expires_at: null,
    salary_min: r.salary_min,
    salary_max: r.salary_max,
    raw: r,
  };
}

/**
 * Build base URLSearchParams shared across all keyword searches.
 * Does NOT include `what` — that's added per-keyword.
 *
 * NOTE: Title/description/contract/hours filters are intentionally NOT sent
 * to Adzuna. They are applied by postFetchFilter (stage 4c) after all sources
 * have fetched, so the same rules apply to every source uniformly.
 *
 * Only fetch-scope params are here: location radius, date window, salary hint.
 */
function buildBaseParams(profile: SearchProfile, where: string): URLSearchParams {
  const params = new URLSearchParams({
    app_id: APP_ID!,
    app_key: APP_KEY!,
    where,
    results_per_page: String(RESULTS_PER_PAGE),
    sort_by: "date",
  });

  // Salary hint — reduces payload size without affecting recall meaningfully
  if (profile.adzuna_salary_min) params.append("salary_min", String(profile.adzuna_salary_min));
  if (profile.adzuna_salary_max) params.append("salary_max", String(profile.adzuna_salary_max));

  // Location radius
  if (profile.adzuna_distance_km) params.append("distance", String(profile.adzuna_distance_km));

  // Date window (auto-computed by orchestrator based on last successful run)
  if (profile.adzuna_max_days_old) params.append("max_days_old", String(profile.adzuna_max_days_old));

  return params;
}

/**
 * Fetch all pages for a single keyword phrase. Returns raw results.
 * Stops early if a page returns fewer than RESULTS_PER_PAGE (no more results).
 */
async function fetchKeyword(
  keyword: string,
  baseParams: URLSearchParams,
  rateLimitDelay: number,
  maxPages: number
): Promise<AdzunaResult[]> {
  const params = new URLSearchParams(baseParams.toString());
  params.set("what", keyword.trim());

  const logKey = decodeURIComponent(
    params.toString().replace(/app_id=[^&]+&app_key=[^&]+&?/, "")
  );
  console.log(`[adzuna] search: ${logKey}`);

  const results: AdzunaResult[] = [];

  for (let page = 1; page <= maxPages; page++) {
    let pageResults: AdzunaResult[];
    try {
      pageResults = await fetchPage(params, page);
    } catch (err) {
      console.error(`[adzuna] "${keyword}" page ${page} error:`, err);
      break;
    }

    if (pageResults.length === 0) break;
    console.log(`[adzuna] "${keyword}" page ${page}: ${pageResults.length} results`);
    results.push(...pageResults);

    // Stop if this page wasn't full — no more pages
    if (pageResults.length < RESULTS_PER_PAGE) break;

    // Delay between pages
    if (page < maxPages) await delay(rateLimitDelay);
  }

  return results;
}

export const adzunaAdapter: SourceAdapter = {
  name: "adzuna",
  tier: 1,
  vertical: "general",
  rateLimitDelay: 1000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    if (!APP_ID || !APP_KEY) {
      throw new Error("ADZUNA_APP_ID and ADZUNA_APP_KEY are required");
    }

    const where = normalizeLocation(profile.location);
    const baseParams = buildBaseParams(profile, where);

    // Run one Adzuna search per keyword phrase.
    // Adzuna's `what` treats spaces as AND — "Data Analyst" means title/desc must
    // contain both "Data" AND "Analyst". Running per-phrase gives full recall for
    // every keyword the user defined, not just the first one.
    const searchTerms = profile.keywords.length > 0
      ? profile.keywords.map((k) => k.trim()).filter(Boolean)
      : ["jobs"];

    const allResults: AdzunaResult[] = [];
    const seenUrls = new Set<string>();

    // First (cold-start) run goes deep; incremental runs stay shallow since the
    // narrow date window early-stops after a page or two anyway.
    const maxPages = profile.is_first_run ? FIRST_RUN_MAX_PAGES : MAX_PAGES;

    for (let i = 0; i < searchTerms.length; i++) {
      const keyword = searchTerms[i];
      const pageResults = await fetchKeyword(keyword, baseParams, this.rateLimitDelay, maxPages);

      let newCount = 0;
      for (const r of pageResults) {
        if (!seenUrls.has(r.redirect_url)) {
          seenUrls.add(r.redirect_url);
          allResults.push(r);
          newCount++;
        }
      }
      console.log(`[adzuna] "${keyword}": ${pageResults.length} fetched, ${newCount} unique new`);

      // Delay between keyword searches (not needed after the last one)
      if (i < searchTerms.length - 1) await delay(this.rateLimitDelay);
    }

    console.log(`[adzuna] total unique: ${allResults.length} across ${searchTerms.length} keyword(s)`);
    return allResults.map(mapToRawJob);
  },

  async isHealthy(): Promise<boolean> {
    if (!APP_ID || !APP_KEY) return false;
    try {
      const params = new URLSearchParams({
        app_id: APP_ID,
        app_key: APP_KEY,
        what: "analyst",
        where: "Sydney",
        results_per_page: "1",
        sort_by: "date",
      });
      const results = await fetchPage(params, 1);
      return results.length > 0;
    } catch {
      return false;
    }
  },
};

export async function enrichWithAdzunaJDs(
  jobs: NormalisedJob[],
  cap: number = 20,
): Promise<{ jobs: NormalisedJob[]; costUsd: number; merged: number; fetched: number }> {
  const adzunaJobs = jobs.filter((j) => j.source === "adzuna" && j.url);
  const targets = adzunaJobs.slice(0, cap);

  if (targets.length === 0) {
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  let mergedCount = 0;
  let fetchedCount = 0;
  console.log(`[adzuna-jd] enriching ${targets.length}/${adzunaJobs.length} adzuna survivors · HTML Scrape`);

  for (const job of targets) {
    // Extract adzuna ID from redirect URL (e.g. https://www.adzuna.com.au/land/ad/5699680690?se=...)
    const idMatch = job.url.match(/\/land\/ad\/(\d+)/);
    if (!idMatch) {
      console.warn(`[adzuna-jd] could not extract Adzuna ID from ${job.url}`);
      continue;
    }
    
    const adzunaId = idMatch[1];
    const detailsUrl = `https://www.adzuna.com.au/details/${adzunaId}`;

    try {
      fetchedCount++;
      const result = await curlFetch(detailsUrl);
      
      if (result.status !== 200) {
        console.warn(`[adzuna-jd] ${detailsUrl} failed with HTTP ${result.status}`);
        continue;
      }

      const $ = cheerio.load(result.body);

      // The JD is wrapped in a section with class 'adp-body'
      const description = $("section.adp-body").text().trim();

      if (description && description.length > 500) {
        job.description = description;
        mergedCount++;
        console.log(`[adzuna-jd] ${detailsUrl}: ${description.length} chars ✓`);
      } else {
        console.warn(`[adzuna-jd] ${detailsUrl}: Could not find JD content in .adp-body`);
      }
    } catch (err) {
      console.error(`[adzuna-jd] ${detailsUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Delay 2.5 seconds between fetches to mimic human speed and avoid rate limits
    await delay(2500);
  }

  return { jobs, costUsd: 0, merged: mergedCount, fetched: fetchedCount };
}
