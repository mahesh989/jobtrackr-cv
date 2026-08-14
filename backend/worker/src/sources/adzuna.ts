import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import type { NormalisedJob } from "../pipeline/types.js";
import * as cheerio from "cheerio";
import { curlFetch } from "../lib/curlfetch.js";
import { sleep as delay } from "./agedCareRoles.js";

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

// Trailing AU state token (abbreviation or full name), preceded by a
// comma/whitespace — i.e. following a real city name. Deliberately does
// NOT also match at the very start of the string (round-3 fix,
// independent review): an earlier draft used `(?:^|[,\s]+)` so a BARE
// multi-word state name like "Western Australia" alone would reduce to
// "Australia" — but that same start-of-string match ALSO fired for every
// other bare state token (`"NSW"`, `"Victoria"`, `"New South Wales"`, all
// 15 of them), discarding a real, useful location down to a bare country
// fallback. Combined with `distance` also being sent as a search radius
// (buildBaseParams), a bare "NSW" input silently became a radius search
// centred on "Australia" — a materially broken query, not just a wider
// one. Adzuna's own location taxonomy accepts state names directly
// (Australia > New South Wales > Sydney), so a bare state name is left
// UNCHANGED here now, same as seekDirect.ts already does — no fallback to
// "Australia" for bare state input at all.
//
// Known, accepted tradeoff (independent review, non-blocking): a hand-typed
// location with NO state qualifier at all, whose own last word happens to
// BE a state name — "Mount Victoria" (a real NSW locality), "Port Victoria"
// (a real SA locality) — truncates to "Mount"/"Port" the same way a state
// suffix would. State-QUALIFIED input is unaffected ("Mount Victoria NSW"
// -> "Mount Victoria", correct). Distinguishing "Victoria the trailing word
// of a real place name" from "Victoria the state suffix" with no other
// signal present is not solvable without a full AU place-name gazetteer —
// out of scope for this fix.
const AU_STATE_SUFFIX_RE = new RegExp(
  "[,\\s]+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT" +
  "|New South Wales|Victoria|Queensland|Western Australia|South Australia" +
  "|Tasmania|Australian Capital Territory|Northern Territory)\\s*$",
  "i",
);

// Redundant trailing country suffix a user sometimes appends to an
// otherwise valid location, e.g. "Sydney, Australia" -> "Sydney". Needs
// the same Western/South lookbehind guard seekDirect.ts uses — now that
// AU_STATE_SUFFIX_RE no longer reduces a bare "Western Australia"/"South
// Australia" to "", this strip would otherwise wrongly mangle it to
// "Western"/"South" on its own.
const AU_COUNTRY_SUFFIX_RE = /,?\s*(?<!\bwestern\s)(?<!\bsouth\s)australia$/i;

/**
 * Normalize location — Adzuna works best with city name only.
 * "Sydney NSW" → "Sydney", "Melbourne, VIC" → "Melbourne"
 *
 * Strips a trailing AU state token, not just the first whitespace-split
 * token — a bare `.split(/[,\s]+/)[0]` truncated every multi-word city
 * name ("Gold Coast" → "Gold", "Alice Springs" → "Alice", "Port
 * Macquarie" → "Port", "Wagga Wagga" → "Wagga") since it had no state
 * suffix to strip in the first place (finding #20 / C28).
 *
 * Also strips a trailing country suffix (round-2 fix — the original
 * split-on-first-token bug accidentally handled "Sydney, Australia" too,
 * as a side effect of truncating everything; the targeted state-only
 * strip regressed that case until this was added). Only re-runs the state
 * strip a second time when the country strip actually removed something
 * (e.g. "Gold Coast, QLD, Australia" -> "Gold Coast, QLD" exposes "QLD" as
 * a new trailing token). Running the state strip twice UNCONDITIONALLY
 * would cascade onto ordinary city names whose own second word happens to
 * be a state name too — "Mount Victoria NSW" must reduce to "Mount
 * Victoria" (one real state token, "NSW", to strip), not "Mount" (which
 * would happen if "Victoria" got treated as a second, spurious state
 * suffix on an unrelated re-run).
 */
export function normalizeLocation(location: string): string {
  let s = location.trim();
  if (!s) return "Australia";
  s = s.replace(AU_STATE_SUFFIX_RE, "").trim();
  const beforeCountryStrip = s;
  s = s.replace(AU_COUNTRY_SUFFIX_RE, "").trim();
  if (s !== beforeCountryStrip) {
    s = s.replace(AU_STATE_SUFFIX_RE, "").trim();
  }
  return s || "Australia";
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
    // contract_time = full_time|part_time; contract_type = permanent|contract.
    employment_types_raw: [r.contract_time, r.contract_type].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    ),
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

// adzuna.com.au /details/<id> rate-limits the Fly worker IP (see adzunaActor.ts
// header comment). This direct-curl path has no residential proxy, so it's the
// one most exposed to that limit — cap it the same way the other direct-fetch
// sources are capped (SEEK_DIRECT_JD_FETCH_CAP, CAREERJET_JD_FETCH_CAP).
export const ADZUNA_DIRECT_JD_FETCH_CAP = 20;

// After this many *consecutive* 429s, stop early instead of grinding through
// the remaining targets one by one — a run of 429s means the IP is already
// rate-limited and further requests will fail the same way.
const CONSECUTIVE_429_ABORT_THRESHOLD = 5;

export async function enrichWithAdzunaJDs(
  jobs: NormalisedJob[],
  cap: number = ADZUNA_DIRECT_JD_FETCH_CAP,
): Promise<{ jobs: NormalisedJob[]; costUsd: number; merged: number; fetched: number }> {
  const adzunaJobs = jobs.filter((j) => j.source === "adzuna" && j.url);
  const targets = adzunaJobs.slice(0, cap);

  if (targets.length === 0) {
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  let mergedCount = 0;
  let fetchedCount = 0;
  let consecutive429s = 0;
  console.log(`[adzuna-jd] enriching ${targets.length}/${adzunaJobs.length} adzuna survivors · HTML Scrape`);

  for (const job of targets) {
    // Adzuna's API returns the job URL in either of two formats, sometimes
    // mixed within a single search response:
    //   • https://www.adzuna.com.au/land/ad/<id>?se=…   (legacy redirect tracker)
    //   • https://www.adzuna.com.au/details/<id>        (direct deep link)
    // We accept both. Previously this regex only matched /land/ad/, so jobs
    // whose API URL was already /details/<id> silently fell through and kept
    // their ~600 char API teaser instead of the full ~3-8k char HTML JD.
    const idMatch = job.url.match(/\/(?:land\/ad|details)\/(\d+)/);
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
        if (result.status === 429) {
          consecutive429s++;
          if (consecutive429s >= CONSECUTIVE_429_ABORT_THRESHOLD) {
            console.warn(
              `[adzuna-jd] aborting after ${consecutive429s} consecutive HTTP 429s — ` +
              `IP is rate-limited; ${targets.length - fetchedCount} remaining survivors keep their API teaser`,
            );
            break;
          }
        } else {
          consecutive429s = 0;
        }
        await delay(2500);
        continue;
      }
      consecutive429s = 0;

      const $ = cheerio.load(result.body);

      // The JD is wrapped in a section with class 'adp-body'. We also try a
      // couple of historical selectors as a defensive fallback — Adzuna has
      // rotated class names before and a single-selector parser silently
      // returns "" if the markup changes.
      let description = $("section.adp-body").text().trim();
      if (description.length < 500) {
        const fallback = $("[data-aut-id='jobDescription'], .job-description, article").first().text().trim();
        if (fallback.length > description.length) description = fallback;
      }

      if (description && description.length > 500) {
        job.description = description;
        mergedCount++;
        console.log(`[adzuna-jd] ${detailsUrl}: ${description.length} chars ✓`);
      } else {
        console.warn(`[adzuna-jd] ${detailsUrl}: JD too short (${description.length} chars) — markup may have changed, keeping API teaser`);
      }
    } catch (err) {
      console.error(`[adzuna-jd] ${detailsUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Delay 2.5 seconds between fetches to mimic human speed and avoid rate limits
    await delay(2500);
  }

  return { jobs, costUsd: 0, merged: mergedCount, fetched: fetchedCount };
}
