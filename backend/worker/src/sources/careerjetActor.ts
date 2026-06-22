// Careerjet JD enrichment — via custom Apify actor (careerjet-jd-fetcher).
//
// The "narrow + expensive" half of the funnel. Listings come FREE from the
// Careerjet v4 API (careerjet.ts); the worker filters/dedups to survivors;
// then this runs the JD-fetcher actor on only the careerjet.com.au survivors
// to get full descriptions over a residential proxy (datacenter is Turnstile-
// blocked — verified 2026-06-22). Mirrors seek.ts enrichWithFullJDs.
//
// Bound to the user's per-user Apify token (same integration as SEEK).

import type { NormalisedJob } from "../pipeline/types.js";

const ACTOR_ID      = process.env.CAREERJET_ACTOR_ID ?? "";
const APIFY_RUN_URL = (id: string) => `https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items`;

// Cap on URLs sent per run — orchestrator calls this AFTER filter+dedup, so
// survivors are typically well below this.
export const CAREERJET_JD_FETCH_CAP = 20;

// Residential proxy + cheerio compute. A JD page is ~10-50KB; ~20/run ≈ cents.
const COST_PER_RUN_USD = 0.02;
const COST_PER_JD_USD  = 0.0015;

const CAREERJET_HOST = "careerjet.com.au";

interface JdItem { url?: string; description?: string; fetchedAt?: string }

export interface CareerjetEnrichResult {
  jobs:    NormalisedJob[];
  costUsd: number;
  merged:  number;
  fetched: number;
}

/**
 * Enrich Careerjet survivors with full JDs via the careerjet-jd-fetcher actor.
 * No-ops (returns jobs unchanged) when CAREERJET_ACTOR_ID is unset or there are
 * no careerjet.com.au survivors. Never throws — failures degrade to the snippet.
 */
export async function enrichCareerjetJDsViaActor(
  jobs:       NormalisedJob[],
  apifyToken: string,
  cap:        number = CAREERJET_JD_FETCH_CAP,
): Promise<CareerjetEnrichResult> {
  if (!ACTOR_ID) return { jobs, costUsd: 0, merged: 0, fetched: 0 };

  // Only careerjet.com.au pages are scrapeable here (employer-redirect listings
  // have unknown page structure — they keep the snippet).
  const targets = jobs
    .filter((j) => j.source === "careerjet" && j.url)
    .filter((j) => { try { return new URL(j.url).hostname.endsWith(CAREERJET_HOST); } catch { return false; } })
    .slice(0, cap);

  if (targets.length === 0) return { jobs, costUsd: 0, merged: 0, fetched: 0 };

  console.log(`[careerjet-jd] actor: ${ACTOR_ID} — enriching ${targets.length} careerjet survivors`);

  let items: JdItem[] = [];
  try {
    const res = await fetch(`${APIFY_RUN_URL(ACTOR_ID)}?timeout=300`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${apifyToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ urls: targets.map((j) => j.url), maxUrls: cap }),
      signal:  AbortSignal.timeout(310_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[careerjet-jd] Apify ${res.status}: ${body.slice(0, 300)}`);
      return { jobs, costUsd: COST_PER_RUN_USD, merged: 0, fetched: targets.length };
    }
    items = (await res.json()) as JdItem[];
  } catch (err) {
    console.error(`[careerjet-jd] actor call failed: ${err instanceof Error ? err.message : err}`);
    return { jobs, costUsd: COST_PER_RUN_USD, merged: 0, fetched: targets.length };
  }

  const descByUrl = new Map<string, string>();
  for (const it of items) {
    if (it.url && it.description && it.description.length > 200) descByUrl.set(it.url, it.description);
  }

  let merged = 0;
  const out = jobs.map((j) => {
    const full = descByUrl.get(j.url);
    if (full) { merged++; return { ...j, description: full }; }
    return j;
  });

  const costUsd = COST_PER_RUN_USD + merged * COST_PER_JD_USD;
  console.log(`[careerjet-jd] merged ${merged}/${targets.length} full descriptions (cost $${costUsd.toFixed(4)})`);
  return { jobs: out, costUsd, merged, fetched: targets.length };
}
