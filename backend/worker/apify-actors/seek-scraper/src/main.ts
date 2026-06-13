/**
 * SEEK AU Job Scraper — custom Apify actor
 *
 * Uses SEEK's internal GraphQL API (discovered via DevTools):
 *   POST https://au.seek.com/graphql
 *   Operation: JobSearchV6
 */

import { Actor, log } from "apify";
import { gotScraping } from "got-scraping";

// ── Input shape ────────────────────────────────────────────────────────────────
interface Input {
  keywords:    string[];
  location?:   string;
  dateRange?:  number;   // days (converted to newSince Unix timestamp)
  maxResults?: number;
}

// ── SEEK GraphQL response types ────────────────────────────────────────────────
interface SeekGqlJob {
  id:          string;
  title:       string;
  companyName?: string;
  advertiser?: { id?: string; description?: string };
  isFeatured:  boolean;
  locations?:  { countryCode?: string; label?: string; seoHierarchy?: { contextualName?: string }[] }[];
  listingDate?: { dateTimeUtc?: string; label?: string };
  salaryLabel?: string;
  teaser?:     string;
  workTypes?:  string[];
  workArrangements?: { displayText?: string }[];
}

interface SeekGqlResponse {
  data?: {
    jobSearchV6?: {
      data:       SeekGqlJob[];
      totalCount?: number;
      solMetadata?: {
        totalJobCount?: number;
        [k: string]: unknown;
      };
    };
  };
  errors?: { message: string }[];
}

// ── Constants ──────────────────────────────────────────────────────────────────
const SEEK_GRAPHQL_URL = "https://au.seek.com/graphql";
const PAGE_SIZE        = 22;

const HEADERS = {
  "Accept":               "application/json",
  "Accept-Language":      "en-AU,en;q=0.9",
  "Content-Type":         "application/json",
  "Origin":               "https://www.seek.com.au",
  "Referer":              "https://www.seek.com.au/",
  "User-Agent":           "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "seek-request-brand":   "seek",
  "seek-request-country": "AU",
  "x-seek-site":          "chalice",
};

// ── GraphQL query (matches the exact operation SEEK sends) ────────────────────
const JOB_SEARCH_QUERY = `
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
`.trim();

// ── Build variables for one page ──────────────────────────────────────────────
function buildVariables(
  keyword:  string,
  location: string,
  newSince: number,
  page:     number,
) {
  const params: Record<string, unknown> = {
    siteKey:  "AU",
    channel:  "mobileWeb",
    keywords: keyword,
    page,
    pageSize: PAGE_SIZE,
    sortMode: "ListedDate",
    newSince,
  };

  // Only add `where` for a specific location — omit for all-Australia
  const loc = location.trim().toLowerCase();
  if (loc && loc !== "australia" && loc !== "all australia") {
    params["where"] = location.trim();
  }

  return { params };
}

// ── Actor entry point ──────────────────────────────────────────────────────────
await Actor.main(async () => {
  const input = await Actor.getInput<Input>();

  const {
    keywords   = [],
    location   = "All Australia",
    dateRange  = 14,
    maxResults = 200,
  } = input ?? {};

  if (keywords.length === 0) {
    log.error("No keywords provided — nothing to search.");
    return;
  }

  // Convert dateRange (days) → Unix timestamp seconds
  const newSince = Math.floor(Date.now() / 1000) - dateRange * 86400;

  log.info(`Starting`, { keywords, location, dateRange, newSince, maxResults });

  // ── Proxy setup ──────────────────────────────────────────────────────────────
  let proxyConfiguration: Awaited<ReturnType<typeof Actor.createProxyConfiguration>> | null = null;
  try {
    proxyConfiguration = await Actor.createProxyConfiguration();
    log.info("Proxy: Apify datacenter rotating");
  } catch (err) {
    log.warning(`Proxy setup failed — running without proxy: ${err}`);
  }

  let grandTotal = 0;

  for (const keyword of keywords) {
    log.info(`[${keyword}] Starting`);
    let page         = 1;
    let keywordTotal = 0;
    let featuredSkipped = 0;
    let totalPages   = 1;  // updated after first response

    while (keywordTotal < maxResults && page <= totalPages) {
      const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

      const variables = buildVariables(keyword, location, newSince, page);
      const body      = JSON.stringify({
        operationName: "JobSearchV6",
        query:         JOB_SEARCH_QUERY,
        variables,
      });

      log.info(`[${keyword}] Page ${page}/${totalPages} — ${SEEK_GRAPHQL_URL}`);
      if (proxyUrl) log.info(`[${keyword}] Via proxy: ${proxyUrl.replace(/:[^:@]+@/, ":***@")}`);

      let bodyStr    = "";
      let statusCode = 0;

      try {
        const res = await gotScraping({
          url:          SEEK_GRAPHQL_URL,
          method:       "POST",
          proxyUrl,
          headers:      HEADERS,
          body,
          timeout:      { request: 30_000 },
          retry:        { limit: 1, methods: ["POST"] },
        });

        statusCode = res.statusCode;
        bodyStr    = res.body as string;
        log.info(`[${keyword}] HTTP ${statusCode}, body ${bodyStr.length} chars`);
        log.info(`[${keyword}] Body preview: ${bodyStr.slice(0, 400)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warning(`[${keyword}] Request failed: ${msg}`);
        break;
      }

      if (statusCode !== 200) {
        log.warning(`[${keyword}] Non-200 response (${statusCode}) — stopping keyword`);
        break;
      }

      let gqlResponse: SeekGqlResponse;
      try {
        gqlResponse = JSON.parse(bodyStr) as SeekGqlResponse;
      } catch {
        log.error(`[${keyword}] Response is not valid JSON — stopping`);
        break;
      }

      if (gqlResponse.errors?.length) {
        log.error(`[${keyword}] GraphQL errors: ${JSON.stringify(gqlResponse.errors)}`);
        break;
      }

      const search = gqlResponse.data?.jobSearchV6;
      if (!search) {
        log.error(`[${keyword}] Unexpected response shape — jobSearchV6 missing`);
        break;
      }

      const jobs        = search.data ?? [];
      const totalJobs   = search.totalCount ?? 0;
      totalPages        = Math.max(1, Math.ceil(totalJobs / PAGE_SIZE));

      log.info(`[${keyword}] totalJobs=${totalJobs}, totalPages=${totalPages}, data.length=${jobs.length}`);

      if (jobs.length === 0) {
        log.info(`[${keyword}] Empty page — done`);
        break;
      }

      const batch: Record<string, unknown>[] = [];

      for (const job of jobs) {
        if (job.isFeatured) { featuredSkipped++; continue; }
        if (keywordTotal >= maxResults) break;
        if (!job.id || !job.title) continue;

        const jobUrl   = `https://www.seek.com.au/job/${job.id}`;
        const company  = job.companyName ?? job.advertiser?.description ?? "";
        const location = job.locations?.[0]?.label ?? "";
        const salary   = job.salaryLabel ?? "";
        const workType = job.workTypes?.[0] ?? "";
        const listedAt = job.listingDate?.dateTimeUtc ?? "";

        batch.push({
          id:          job.id,
          title:       job.title,
          company,
          location,
          area:        "",   // SEEK GraphQL doesn't separate area — kept for schema compat
          salary,
          teaser:      job.teaser ?? "",
          listingDate: listedAt,
          url:         jobUrl,
          workType,
          keyword,
        });
        keywordTotal++;
      }

      if (batch.length > 0) await Actor.pushData(batch);

      log.info(`[${keyword}] Page ${page}/${totalPages}: pushed ${batch.length}, featured skipped ${featuredSkipped}, total ${keywordTotal}`);

      if (jobs.length < PAGE_SIZE || keywordTotal >= maxResults) break;
      page++;
    }

    log.info(`[${keyword}] Done: ${keywordTotal} jobs`);
    grandTotal += keywordTotal;
  }

  log.info(`Complete — ${grandTotal} total jobs`);
});
