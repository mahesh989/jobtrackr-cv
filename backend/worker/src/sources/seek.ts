// SEEK AU adapter — via custom Apify actor (seek-au-scraper)
//
// SEEK blocks direct HTTP from static datacenter IPs.
// Our custom actor hits SEEK's internal JSON API with rotating IPs via
// Apify proxy, keeping costs inside the $5/month free tier.
//
// Architecture: factory function, NOT a static export.
// SEEK requires a per-user Apify token — it can't live in the global adapters[]
// array. The orchestrator creates this adapter at runtime if the user has a
// valid, quota-remaining Apify integration, then discards it after the run.
//
// Actor output fields (our custom actor):
//   id, title, company, location, area, salary, teaser,
//   listingDate, url, workType, keyword
//
// Pricing: Apify platform compute only (~$0.002/result + $0.02/run).
// SEEK hard cap: 550 results per search (platform limit).

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import type { NormalisedJob } from "../pipeline/types.js";

// Actor IDs: set via env vars after deploying.
// Format: "<your-apify-username>~seek-au-scraper"
const ACTOR_ID         = process.env.SEEK_ACTOR_ID    ?? "prospect_fuzz~seek-au-scraper";
const JD_ACTOR_ID      = process.env.SEEK_JD_ACTOR_ID ?? "prospect_fuzz~seek-jd-fetcher";
const APIFY_RUN_URL    = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`;
const APIFY_JD_RUN_URL = `https://api.apify.com/v2/acts/${JD_ACTOR_ID}/run-sync-get-dataset-items`;

// Cost estimate — used by orchestrator to update quota_used_usd after each run.
const COST_PER_RESULT_USD = 0.002;
const COST_PER_RUN_USD    = 0.02;
const COST_JD_RUN_USD     = 0.04;   // ~80s Playwright compute for ~20 JDs

// Cap on URLs sent to the JD fetcher per run. Orchestrator should only
// call this AFTER filter+dedup, so survivors are typically far below this.
export const SEEK_JD_FETCH_CAP = 20;

// ── Output shape from our custom actor ────────────────────────────────────────
interface SeekItem {
  id?:          string;
  title?:       string;
  company?:     string;     // already resolved from advertiser.description
  location?:    string;     // e.g. "Sydney NSW 2000"
  area?:        string;     // e.g. "CBD, Inner West & Eastern Suburbs"
  salary?:      string;     // e.g. "$90,000 – $110,000"
  teaser?:      string;
  listingDate?: string;     // ISO date string (NOT "featured" — filtered at actor level)
  url?:         string;
  workType?:    string;
  keyword?:     string;     // which search keyword found this job
}

// ── Salary parsing ─────────────────────────────────────────────────────────────
function parseSalary(text: string | undefined): { salary_min?: number; salary_max?: number } {
  if (!text) return {};
  const nums = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return {};
  const isHourly = /per hour|hourly|\/hr/i.test(text);
  const [lo, hi] = nums;
  const scale = isHourly ? 2080 : 1;  // annualise hourly (2080 working hours/year)
  return {
    salary_min: lo ? lo * scale : undefined,
    salary_max: (hi ?? lo) * scale,
  };
}

// ── Result returned to orchestrator (includes cost for quota tracking) ─────────
export interface SeekFetchResult {
  jobs:    RawJob[];
  costUsd: number;   // orchestrator persists this to user_integrations.quota_used_usd
}

// ── Factory ───────────────────────────────────────────────────────────────────
/**
 * Create a SEEK adapter bound to a specific user's Apify token.
 * Call createSeekAdapter(decryptedToken) from the orchestrator after loading
 * the user's integration — never store the adapter globally.
 */
export function createSeekAdapter(apifyToken: string): {
  fetchJobs(profile: SearchProfile): Promise<SeekFetchResult>;
  isHealthy(): Promise<boolean>;
  name: string;
  tier: SourceAdapter["tier"];
} {
  return {
    name: "seek",
    tier: 1,

    async fetchJobs(profile: SearchProfile): Promise<SeekFetchResult> {
      const allJobs: RawJob[] = [];
      // Always use a fixed window — SEEK is deduped at the DB layer, so repeating
      // jobs costs nothing extra. A short adaptive window (like Adzuna uses to cut
      // API spend) causes the actor to return 0 results on same-day re-runs.
      const daysOld = 14;

      console.log(`[seek] actor: ${ACTOR_ID}`);
      console.log(`[seek] keywords: ${profile.keywords.join(", ")}`);

      let items: SeekItem[] = [];
      try {
        // Run all keywords in one actor call — the actor handles pagination per keyword
        const res = await fetch(
          `${APIFY_RUN_URL}?timeout=300`,
          {
            method:  "POST",
            headers: {
              Authorization:  `Bearer ${apifyToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              keywords:   profile.keywords,
              location:   profile.location || "All Australia",
              dateRange:  daysOld,
              maxResults: 200,
            }),
            signal: AbortSignal.timeout(310_000),
          }
        );

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`[seek] Apify ${res.status}: ${body.slice(0, 300)}`);
          return { jobs: [], costUsd: COST_PER_RUN_USD };
        }

        items = (await res.json()) as SeekItem[];
        console.log(`[seek] actor returned ${items.length} raw items`);
      } catch (err) {
        console.error(`[seek] actor call failed: ${err instanceof Error ? err.message : err}`);
        return { jobs: [], costUsd: COST_PER_RUN_USD };
      }

      let skipped = 0;
      for (const item of items) {
        // Safety: featured items should be filtered by the actor, but double-check
        if (
          typeof item.listingDate === "string" &&
          item.listingDate.toLowerCase() === "featured"
        ) {
          skipped++;
          continue;
        }

        const url = item.url ?? (item.id ? `https://www.seek.com.au/job/${item.id}` : "");
        if (!url || !item.title) continue;

        // Combine area + location for display: "CBD, Inner West & Eastern Suburbs · Sydney NSW"
        const location = [item.area, item.location]
          .filter(Boolean)
          .join(" · ") || profile.location;

        const description = item.teaser ?? "";
        const posted_at   = item.listingDate
          ? (() => { try { return new Date(item.listingDate!).toISOString(); } catch { return null; } })()
          : null;

        const { salary_min, salary_max } = parseSalary(item.salary);

        allJobs.push({
          url,
          title:       item.title,
          company:     item.company ?? "",
          location,
          description,
          source:      "seek",
          source_tier: 1,
          posted_at,
          expires_at:  null,
          ...(salary_min !== undefined && { salary_min }),
          ...(salary_max !== undefined && { salary_max }),
          raw: item,
        });
      }

      if (skipped > 0) {
        console.log(`[seek] skipped ${skipped} featured/sponsored listings (post-filter)`);
      }

      const costUsd = COST_PER_RUN_USD + allJobs.length * COST_PER_RESULT_USD;
      console.log(`[seek] done — ${allJobs.length} jobs, estimated cost $${costUsd.toFixed(4)}`);

      return { jobs: allJobs, costUsd };
    },

    async isHealthy(): Promise<boolean> {
      // Confirm the token is accepted by Apify — lightweight, no actor run
      try {
        const res = await fetch("https://api.apify.com/v2/users/me", {
          headers: { Authorization: `Bearer ${apifyToken}` },
          signal:  AbortSignal.timeout(8_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

// ── Enrichment ────────────────────────────────────────────────────────────────
/**
 * Fetch full job descriptions for SEEK jobs that survived the filter + dedup
 * stages. Designed to be called by the orchestrator AFTER stage 5+6, so we
 * only pay for JDs of jobs that will actually be saved.
 *
 * Mutates nothing — returns a new array. Non-fatal: if the JD actor fails,
 * input jobs are returned unchanged (with their teaser-level descriptions).
 */
export async function enrichWithFullJDs(
  jobs:       NormalisedJob[],
  apifyToken: string,
  cap:        number = SEEK_JD_FETCH_CAP
): Promise<{ jobs: NormalisedJob[]; costUsd: number; merged: number; fetched: number }> {
  // Only SEEK jobs need this enrichment; everything else passes through.
  const seekJobs   = jobs.filter((j) => j.source === "seek" && j.url);
  const targetUrls = seekJobs.slice(0, cap).map((j) => j.url);

  if (targetUrls.length === 0) {
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  console.log(`[seek-jd] enriching ${targetUrls.length} SEEK survivors (cap ${cap})`);

  try {
    const res = await fetch(`${APIFY_JD_RUN_URL}?timeout=300`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${apifyToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ urls: targetUrls, maxUrls: cap }),
      signal: AbortSignal.timeout(310_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[seek-jd] HTTP ${res.status}: ${body.slice(0, 200)} — keeping teasers`);
      return { jobs, costUsd: COST_JD_RUN_USD, merged: 0, fetched: targetUrls.length };
    }

    const items = (await res.json()) as Array<{ url?: string; description?: string }>;
    const descByUrl = new Map<string, string>();
    for (const r of items) {
      if (r.url && r.description) descByUrl.set(r.url, r.description);
    }

    let merged = 0;
    const out = jobs.map((job) => {
      const full = descByUrl.get(job.url);
      if (full) { merged++; return { ...job, description: full }; }
      return job;
    });

    console.log(`[seek-jd] merged ${merged}/${targetUrls.length} full descriptions`);
    return { jobs: out, costUsd: COST_JD_RUN_USD, merged, fetched: targetUrls.length };
  } catch (err) {
    console.warn(`[seek-jd] failed: ${err instanceof Error ? err.message : err} — keeping teasers`);
    return { jobs, costUsd: 0, merged: 0, fetched: targetUrls.length };
  }
}
