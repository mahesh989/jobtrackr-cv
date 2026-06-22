// Adzuna JD enrichment — via custom Apify actor (adzuna-jd-fetcher).
//
// adzuna.com.au /details/<id> rate-limits the Fly worker IP (HTTP 429 with
// Retry-After: 3600). A residential AU IP returns the real HTML cleanly.
// This adapter runs our custom actor on Apify (Cheerio over residential
// proxy — no browser, page is static HTML) to enrich Adzuna survivors.
//
// Bound to the user's per-user Apify token (same integration as SEEK).

import type { NormalisedJob } from "../pipeline/types.js";

const ACTOR_ID      = process.env.ADZUNA_ACTOR_ID ?? "";
const APIFY_RUN_URL = (id: string) => `https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items`;

// Cap on URLs sent per run — orchestrator calls this AFTER filter+dedup, so
// survivors are typically well below this.
export const ADZUNA_JD_FETCH_CAP = 50;

// Residential proxy + cheerio compute. A JD page is ~80KB; ~50/run ≈ a few MB.
const COST_PER_RUN_USD = 0.02;
const COST_PER_JD_USD  = 0.0008;

const ADZUNA_HOST = "adzuna.com.au";

interface JdItem { url?: string; description?: string; fetchedAt?: string }

export interface AdzunaEnrichResult {
  jobs:    NormalisedJob[];
  costUsd: number;
  merged:  number;
  fetched: number;
}

/**
 * Enrich Adzuna survivors with full JDs via the adzuna-jd-fetcher actor.
 * No-ops (returns jobs unchanged) when ADZUNA_ACTOR_ID is unset or there
 * are no adzuna.com.au survivors. Never throws — failures degrade to the
 * API teaser.
 */
export async function enrichAdzunaJDsViaActor(
  jobs:       NormalisedJob[],
  apifyToken: string,
  cap:        number = ADZUNA_JD_FETCH_CAP,
): Promise<AdzunaEnrichResult> {
  if (!ACTOR_ID) return { jobs, costUsd: 0, merged: 0, fetched: 0 };

  const targets = jobs
    .filter((j) => j.source === "adzuna" && j.url)
    .filter((j) => { try { return new URL(j.url).hostname.endsWith(ADZUNA_HOST); } catch { return false; } })
    .slice(0, cap);

  if (targets.length === 0) return { jobs, costUsd: 0, merged: 0, fetched: 0 };

  console.log(`[adzuna-jd] actor: ${ACTOR_ID} — enriching ${targets.length} adzuna survivors`);

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
      console.error(`[adzuna-jd] Apify ${res.status}: ${body.slice(0, 300)}`);
      return { jobs, costUsd: COST_PER_RUN_USD, merged: 0, fetched: targets.length };
    }
    items = (await res.json()) as JdItem[];
  } catch (err) {
    console.error(`[adzuna-jd] actor call failed: ${err instanceof Error ? err.message : err}`);
    return { jobs, costUsd: COST_PER_RUN_USD, merged: 0, fetched: targets.length };
  }

  // The actor normalizes URLs to /details/<id>, but our survivor jobs may
  // carry /land/ad/<id> URLs. Key the merge by adzuna id (extracted both sides).
  const descById = new Map<string, string>();
  for (const it of items) {
    if (!it.url || !it.description || it.description.length <= 500) continue;
    const m = it.url.match(/\/(?:land\/ad|details)\/(\d+)/);
    if (m) descById.set(m[1], it.description);
  }

  let merged = 0;
  const out = jobs.map((j) => {
    if (j.source !== "adzuna") return j;
    const m = j.url.match(/\/(?:land\/ad|details)\/(\d+)/);
    if (!m) return j;
    const full = descById.get(m[1]);
    if (full) { merged++; return { ...j, description: full }; }
    return j;
  });

  const costUsd = COST_PER_RUN_USD + merged * COST_PER_JD_USD;
  console.log(`[adzuna-jd] merged ${merged}/${targets.length} full descriptions (cost $${costUsd.toFixed(4)})`);
  return { jobs: out, costUsd, merged, fetched: targets.length };
}
