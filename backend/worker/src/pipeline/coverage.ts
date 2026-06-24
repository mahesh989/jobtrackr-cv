// Global job-bucket — search-coverage ledger (Phase A).
//
// A search SLICE is the unit of freshness: (normalised keyword × location-cell ×
// source). The `search_coverage` table (migration 066) records, per slice, when
// it was last refreshed from the source and how far back we have backfilled it.
//
// Phase A (this file): slice resolution + WRITE-ONLY population. After each
// successful run the orchestrator calls recordCoverage() so the ledger is warm.
// Nothing acts on it yet — existing scrape depth (per-profile lookback) is
// unchanged.
//
// Phase B (later): readCoverage() + computeDeltaDays() drive the scrape delta
// ([last_refreshed_at, now]) and the bucket-first serve, once global_jobs /
// profile_jobs exist. Those helpers are defined here now so the contract is
// stable, but the orchestrator does not call them in Phase A.
//
// All DB access is best-effort and try/catch-guarded by callers: if migration
// 066 has not been applied yet, a write simply no-ops with a warning and the
// pipeline continues unaffected.

import { db } from "../db/client.js";
import { normaliseCity } from "./normalise/keys.js";

/** Sources whose coverage we track — the date-aware adapters only. Board-specific
 *  adapters (greenhouse, lever, RSS, gov health) are out of slice scope in v1. */
export const COVERAGE_SOURCES = new Set(["seek", "adzuna", "careerjet"]);

export interface CoverageSlice {
  keyword_norm: string;
  location_cell: string;
  source: string;
}

export interface CoverageRow extends CoverageSlice {
  last_refreshed_at: string;
  covered_through: string;
  last_job_count: number;
  refreshing: boolean;
  refresh_started_at: string | null;
}

/** lower + trim + collapse internal whitespace. "  Assistant   In Nursing " → "assistant in nursing". */
export function normaliseKeyword(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Expand a profile's search into the slices it covers: one per
 * (keyword × source). Location-cell is derived once from the search location
 * (what we query the source with), NOT per-job location.
 *
 * Empty keywords or non-coverage sources are dropped. Duplicate slices
 * (e.g. two keywords that normalise to the same string) are de-duplicated.
 */
export function resolveSlices(
  keywords: string[],
  location: string,
  sourcesRun: string[],
): CoverageSlice[] {
  const cell = normaliseCity(location);
  const kws = Array.from(
    new Set(keywords.map(normaliseKeyword).filter((k) => k.length > 0)),
  );
  const srcs = sourcesRun.filter((s) => COVERAGE_SOURCES.has(s));

  const out: CoverageSlice[] = [];
  const seen = new Set<string>();
  for (const keyword_norm of kws) {
    for (const source of srcs) {
      const key = `${keyword_norm}|${cell}|${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ keyword_norm, location_cell: cell, source });
    }
  }
  return out;
}

/**
 * WRITE-ONLY (Phase A). Upsert one coverage row per slice after a successful run.
 *   last_refreshed_at = now
 *   covered_through   = now − lookbackDays  (the window we just fetched)
 *   last_job_count    = run-level jobs-fetched signal (coarse; not per-slice in v1)
 *
 * Best-effort: any error (incl. table-not-found before migration 066 is applied)
 * is swallowed with a warning so the pipeline is never affected.
 */
export async function recordCoverage(
  slices: CoverageSlice[],
  lookbackDays: number,
  jobsFetched: number,
): Promise<void> {
  if (slices.length === 0) return;
  const now = new Date();
  const coveredThrough = new Date(now.getTime() - lookbackDays * 86_400_000);

  const rows = slices.map((s) => ({
    keyword_norm: s.keyword_norm,
    location_cell: s.location_cell,
    source: s.source,
    last_refreshed_at: now.toISOString(),
    covered_through: coveredThrough.toISOString(),
    last_job_count: jobsFetched,
    // refreshing / refresh_started_at left to their defaults (Phase C owns them)
  }));

  try {
    const { error } = await db
      .from("search_coverage")
      .upsert(rows, { onConflict: "keyword_norm,location_cell,source", ignoreDuplicates: false });
    if (error) {
      console.warn(`[coverage] recordCoverage skipped — ${error.message}`);
    } else {
      console.log(`[coverage] recorded ${rows.length} slice(s) (lookback ${lookbackDays}d, ${jobsFetched} fetched)`);
    }
  } catch (err) {
    console.warn(`[coverage] recordCoverage threw — ${err instanceof Error ? err.message : err}`);
  }
}

// ── Phase B contract (defined now, not yet called by the orchestrator) ───────

/** Read existing coverage rows for a set of slices. Returns a map keyed by the
 *  same "keyword|cell|source" string resolveSlices builds, for O(1) lookup. */
export async function readCoverage(
  slices: CoverageSlice[],
): Promise<Map<string, CoverageRow>> {
  const map = new Map<string, CoverageRow>();
  if (slices.length === 0) return map;
  const cells = Array.from(new Set(slices.map((s) => s.location_cell)));
  const kws = Array.from(new Set(slices.map((s) => s.keyword_norm)));
  try {
    const { data, error } = await db
      .from("search_coverage")
      .select("keyword_norm, location_cell, source, last_refreshed_at, covered_through, last_job_count, refreshing, refresh_started_at")
      .in("keyword_norm", kws)
      .in("location_cell", cells);
    if (error) {
      console.warn(`[coverage] readCoverage skipped — ${error.message}`);
      return map;
    }
    for (const r of (data ?? []) as CoverageRow[]) {
      map.set(`${r.keyword_norm}|${r.location_cell}|${r.source}`, r);
    }
  } catch (err) {
    console.warn(`[coverage] readCoverage threw — ${err instanceof Error ? err.message : err}`);
  }
  return map;
}

/**
 * Phase B: days to scrape for a slice = ceil(now − last_refreshed_at) + 1 buffer,
 * capped at `maxDays` (the 30-day retention). No prior coverage → null (caller
 * should cold-start at maxDays).
 */
export function computeDeltaDays(
  row: CoverageRow | undefined,
  maxDays = 30,
): number | null {
  if (!row) return null;
  const daysSince = Math.ceil(
    (Date.now() - new Date(row.last_refreshed_at).getTime()) / 86_400_000,
  );
  return Math.min(daysSince + 1, maxDays);
}
