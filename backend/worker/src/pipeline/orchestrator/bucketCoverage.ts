import {
  resolveSlices,
  readCoverage,
  computeProfileLookback,
  sliceDeltaDays,
  acquireSliceLocks,
  type CoverageSlice,
} from "../coverage.js";
import { bucketEnabled, evictStaleBucket, BUCKET_RETENTION_DAYS } from "../bucket.js";
import type { FullProfile } from "./types.js";

/**
 * Coverage-driven scrape planning for bucket mode (USE_GLOBAL_BUCKET).
 *
 * The scrape delta is driven by the SLICE's freshness across ALL users, not by
 * this profile's last run: fresh slices scrape little or nothing, because the
 * full window is still served from the shared bucket afterwards.
 *
 * Returns a possibly-revised lookbackDays plus the single-flight lock state.
 * Does NOT scrape, write, or serve - planning and lock acquisition only. With
 * the flag off it is a no-op that echoes lookbackDays straight back.
 */
export async function planBucketCoverage(
  profile: FullProfile,
  lookbackDays: number,
  fullRefresh: boolean,
): Promise<{
  slices: CoverageSlice[];
  skipScrape: boolean;
  lockedSlices: CoverageSlice[];
  lookbackDays: number;
}> {
  // ── Global bucket (USE_GLOBAL_BUCKET): coverage-driven lookback ────────────
  // The scrape delta is driven by the SLICE'S freshness (across all users), not
  // this profile's last run. Fresh slices → scrape little/nothing; we still
  // serve the full window from the shared bucket later.
  let bucketSlices: CoverageSlice[] = [];
  let bucketSkipScrape = false;          // skip stage 2 entirely; serve from bucket
  let bucketLockedSlices: CoverageSlice[] = [];  // slices we hold the refresh lock on (release after run)
  if (bucketEnabled()) {
    await evictStaleBucket();
    const candidateSources =
      profile.enabled_sources && profile.enabled_sources.length > 0
        ? profile.enabled_sources
        : ["seek", "adzuna", "careerjet"];
    bucketSlices = resolveSlices(profile.keywords, profile.location, candidateSources);
    if (bucketSlices.length > 0 && !fullRefresh) {
      const coverage = await readCoverage(bucketSlices);
      const key = (s: CoverageSlice) => `${s.keyword_norm}|${s.location_cell}|${s.source}`;
      const { lookbackDays: bucketLookback, allFresh } = computeProfileLookback(
        coverage, bucketSlices, BUCKET_RETENTION_DAYS,
      );
      // Floor at 1 day. A 0-day lookback is FALSY and makes date-aware adapters
      // (Adzuna: `if (profile.adzuna_max_days_old)`) DROP the filter and fetch
      // their full default window. 1 day = minimal top-up.
      lookbackDays = Math.max(bucketLookback, 1);

      if (allFresh) {
        // Every slice refreshed within the TTL → no scrape needed at all.
        bucketSkipScrape = true;
        console.log(`[pipeline] bucket: all ${bucketSlices.length} slices fresh — skip scrape, serve from bucket`);
      } else {
        // Single-flight: claim the stale slices. Cold slices (no coverage row
        // yet) MUST be scraped to populate, so we never skip when any exist.
        const stale = bucketSlices.filter((s) => sliceDeltaDays(coverage.get(key(s)), BUCKET_RETENTION_DAYS) > 0);
        const cold = stale.filter((s) => !coverage.has(key(s)));
        if (cold.length === 0) {
          const claimed = await acquireSliceLocks(stale);
          if (claimed.length === 0) {
            // Another in-flight refresh already owns all stale slices → don't
            // double-scrape; serve the (about-to-be-refreshed) bucket.
            bucketSkipScrape = true;
            console.log(`[pipeline] bucket: ${stale.length} stale slices locked by another refresh — skip scrape, serve from bucket`);
          } else {
            // Only the slices THIS call actually claimed — not the full
            // `stale` list — or releasing later would release locks this run
            // never held, letting a third run double-scrape a still-in-flight
            // slice (#34 audit).
            bucketLockedSlices = claimed;
            console.log(`[pipeline] bucket lookback: ${lookbackDays}d (claimed ${claimed.length}/${stale.length} stale slices)`);
          }
        } else {
          // Cold slices present → scrape; still claim existing locks for hygiene.
          // Cold slices themselves were never locked (no coverage row to lock),
          // so they must not appear in bucketLockedSlices either.
          const claimed = await acquireSliceLocks(stale.filter((s) => coverage.has(key(s))));
          bucketLockedSlices = claimed;
          console.log(`[pipeline] bucket lookback: ${lookbackDays}d (${cold.length} cold + ${stale.length - cold.length} stale slices — scraping)`);
        }
      }
    }
  }

  return {
    slices: bucketSlices,
    skipScrape: bucketSkipScrape,
    lockedSlices: bucketLockedSlices,
    lookbackDays,
  };
}
