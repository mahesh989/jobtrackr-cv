// Careerjet AU adapter — via custom Apify actor (careerjet-au-scraper).
//
// careerjet.com.au Turnstile-challenges datacenter IPs, so the Fly worker can't
// scrape it directly (curl_cffi gets a challenge page → 0 jobs). This adapter
// runs our custom actor on Apify, which scrapes over an internal RESIDENTIAL AU
// proxy (no challenge for residential IPs) and returns listings + full JDs.
//
// Architecture mirrors seek.ts: a factory bound to a per-user Apify token. The
// orchestrator creates it at runtime from the user's Apify integration (the
// same one SEEK uses) and discards it after the run. When no token is present,
// the orchestrator falls back to the free v4 API adapter (careerjet.ts).
//
// Actor output fields: title, company, location, salary, url, description, keyword
// `description` is the full JD when the actor enriched it, else the listing teaser.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

// Actor id: set via env after deploying. Format "<apify-username>~careerjet-au-scraper".
const ACTOR_ID      = process.env.CAREERJET_ACTOR_ID ?? "prospect_fuzz~careerjet-au-scraper";
const APIFY_RUN_URL = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`;

// Cost estimate — residential proxy + cheerio compute. Cheaper than Playwright
// actors but pricier than SEEK's datacenter path because residential is required.
const COST_PER_RUN_USD    = 0.03;
const COST_PER_RESULT_USD = 0.0006;

interface CareerjetItem {
  title?:       string;
  company?:     string;
  location?:    string;
  salary?:      string;
  url?:         string;
  description?: string;
  keyword?:     string;
}

function parseSalary(text: string | undefined): { salary_min?: number; salary_max?: number } {
  if (!text) return {};
  const nums = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return {};
  const isHourly  = /per hour|hourly|\/hr/i.test(text);
  const isDaily   = /per day|daily/i.test(text);
  const isWeekly  = /per week|weekly/i.test(text);
  const isMonthly = /per month|monthly/i.test(text);
  const [lo, hi] = nums;
  const scale = isHourly ? 2080 : isDaily ? 260 : isWeekly ? 52 : isMonthly ? 12 : 1;
  return {
    salary_min: lo ? Math.round(lo * scale) : undefined,
    salary_max: Math.round((hi ?? lo) * scale),
  };
}

export interface CareerjetActorResult {
  jobs:    RawJob[];
  costUsd: number;
}

/**
 * Create a Careerjet actor adapter bound to a specific user's Apify token.
 * Mirrors createSeekAdapter — never store globally.
 */
export function createCareerjetActorAdapter(apifyToken: string): {
  fetchJobs(profile: SearchProfile): Promise<CareerjetActorResult>;
  isHealthy(): Promise<boolean>;
  name: string;
  tier: SourceAdapter["tier"];
} {
  return {
    name: "careerjet",
    tier: 1,

    async fetchJobs(profile: SearchProfile): Promise<CareerjetActorResult> {
      const maxPages = profile.is_first_run ? 6 : 4;
      console.log(`[careerjet] actor: ${ACTOR_ID}`);
      console.log(`[careerjet] keywords: ${profile.keywords.join(", ")} · location: ${profile.location || "(AU-wide)"}`);

      let items: CareerjetItem[] = [];
      try {
        const res = await fetch(`${APIFY_RUN_URL}?timeout=300`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${apifyToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            keywords:   profile.keywords,
            location:   profile.location || "All Australia",
            maxResults: 200,
            maxPages,
            fetchJDs:   true,
            jdCap:      40,
          }),
          signal: AbortSignal.timeout(310_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`[careerjet] Apify ${res.status}: ${body.slice(0, 300)}`);
          return { jobs: [], costUsd: COST_PER_RUN_USD };
        }
        items = (await res.json()) as CareerjetItem[];
        console.log(`[careerjet] actor returned ${items.length} raw items`);
      } catch (err) {
        console.error(`[careerjet] actor call failed: ${err instanceof Error ? err.message : err}`);
        return { jobs: [], costUsd: COST_PER_RUN_USD };
      }

      const allJobs: RawJob[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const url = (item.url ?? "").split("?")[0];
        if (!url || !item.title) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        const { salary_min, salary_max } = parseSalary(item.salary);
        allJobs.push({
          url,
          title:       item.title,
          company:     item.company ?? "",
          location:    item.location || profile.location,
          description: item.description ?? "",
          source:      "careerjet",
          source_tier: 1,
          posted_at:   null,
          expires_at:  null,
          ...(salary_min !== undefined && { salary_min }),
          ...(salary_max !== undefined && { salary_max }),
          raw:         { ...item, _keyword: item.keyword },
        });
      }

      const costUsd = COST_PER_RUN_USD + allJobs.length * COST_PER_RESULT_USD;
      console.log(`[careerjet] done — ${allJobs.length} jobs, estimated cost $${costUsd.toFixed(4)}`);
      return { jobs: allJobs, costUsd };
    },

    async isHealthy(): Promise<boolean> {
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
