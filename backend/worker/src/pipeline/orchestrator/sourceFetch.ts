import pLimit from "p-limit";
import { db } from "../../db/client.js";
import { adapters } from "../../sources/index.js";
import type { RawJob } from "../../sources/types.js";
import { isBlocked, recordSuccess, recordFailure } from "../healthTracker.js";
import { setStage } from "../runLog.js";
import { createSeekAdapter } from "../../sources/seek.js";
import { seekDirectAdapter } from "../../sources/seekDirect.js";
import { checkCancellation } from "./concurrency.js";
import { SEEK_MONTHLY_BUDGET_USD } from "./apifyIntegration.js";
import type { FullProfile, UserIntegration, SourceMethods, SubscriptionTier } from "./types.js";

/**
 * SEEK counts as "covered" only if a scrape was actually ATTEMPTED this run
 * (not skipped because the bucket serve is fresh/locked, or because SEEK is
 * disabled for this profile) AND it either returned results or legitimately
 * succeeded empty. A 403→0-item-actor chain yields nothing and is NOT marked
 * covered, so the slice stays stale and SEEK is retried next run instead of
 * being cached as fresh for the TTL window.
 *
 * B5-P2: the ORIGINAL condition (`seekEnabled && (seekRawCount > 0 ||
 * !seekDirectFailed)`) omitted the bucketSkipScrape check — `seekDirectFailed`
 * is only ever set to `true` inside the branch that actually attempts a
 * fetch, so on a run that skips scraping entirely (bucketSkipScrape),
 * `seekDirectFailed` sits at its unset default `false`, `!seekDirectFailed`
 * evaluates `true`, and the slice got marked freshly covered despite SEEK
 * never having been touched. On a future run that condition (bucket
 * fresh/locked) still triggered a skip, but coverage still looked fresh
 * from the LAST skip — a self-sustaining skip loop where SEEK is never
 * actually scraped again yet always looks covered.
 *
 * Extracted as a pure function for testability — mocking the whole stage-2
 * orchestrator (DB, adapters, healthTracker, Apify) just to test one boolean
 * decision isn't worth it.
 */
export function shouldMarkSeekCovered(params: {
  seekEnabled: boolean;
  bucketSkipScrape: boolean;
  seekRawCount: number;
  seekDirectFailed: boolean;
}): boolean {
  const { seekEnabled, bucketSkipScrape, seekRawCount, seekDirectFailed } = params;
  if (!seekEnabled || bucketSkipScrape) return false;
  return seekRawCount > 0 || !seekDirectFailed;
}

/**
 * Stage 2 - the source layer.
 *
 * The generic adapters are independent origins that never write to the DB and
 * share no client state during fetch, so they run CONCURRENTLY (bounded), with
 * per-task try/catch giving the same isolation the old sequential loop had.
 * SEEK is handled separately: it has a direct (free) path with a tier-gated
 * Apify actor fallback and its own spend accounting.
 *
 * ORDERING IS LOAD-BEARING: the three checkCancellation() calls sit exactly
 * where they did before. They are the ONLY cancellation points in the whole
 * pipeline - once stage 2 finishes a run can no longer be cancelled - so
 * moving, adding or removing one changes user-visible cancel latency.
 *
 * Mutates `metrics` in place rather than returning counters: a throw here (a
 * cancellation, or a setStage failure) must still leave the sources that
 * already succeeded visible to the outer catch's failure report.
 */
export async function fetchFromSources(
  profile: FullProfile,
  runLogId: string,
  tier: SubscriptionTier,
  opts: { skipScrape: boolean },
  creds: {
    adapter: ReturnType<typeof createSeekAdapter> | null;
    integration: UserIntegration | null;
  },
  sourceEnabled: (name: string) => boolean,
  metrics: {
    sourcesRun: string[];
    coverageSources: Set<string>;
    sourceMethods: SourceMethods;
  },
): Promise<RawJob[]> {
  const seekAdapter = creds.adapter;
  const seekIntegration = creds.integration;
  const bucketSkipScrape = opts.skipScrape;
  const { sourcesRun, coverageSources, sourceMethods } = metrics;
  let seekRawCount = 0;
  // Stage 2: source layer. The 11 sources are independent origins that
  // neither write to the DB nor share any client/session state during
  // fetch (each fetchJobs() call is return-only — Stage 12 does the one
  // batched save, later) — so they run CONCURRENTLY, bounded to
  // STAGE2_CONCURRENCY at a time, instead of one after another. This alone
  // collapsed a 7-minute run (96% of it spent in sequential stage-2 fetch)
  // to roughly the duration of the single slowest source. Promise.allSettled
  // (via the per-task try/catch below) means one source's failure/timeout
  // never blocks or cancels the others — same isolation the old sequential
  // try/catch gave, just running in parallel.
  const STAGE2_CONCURRENCY = 6;
  const stage2Limit = pLimit(STAGE2_CONCURRENCY);
  const rawJobs: RawJob[] = [];

  // Hard wall-clock deadline around every adapter fetch. The inner layers
  // (curlFetch 35s SIGKILL, per-request timeouts, loop breaks) each have
  // their own guards, but a live incident (2026-07-18, run 00626807) showed
  // a seek-direct fetch going silent for 9 minutes with none of them firing
  // — pages 4-7 never logged, run stuck at "Fetching from SEEK" until the
  // user cancelled. This orchestrator-level race is the guarantee that no
  // single source can hang a run regardless of WHERE inside it wedges.
  // Deadlines are deliberately generous (only true hangs trip them, not
  // slow-but-working fetches). On timeout the underlying work is orphaned,
  // not killed — its own inner timeouts / process exit clean it up.
  const withDeadline = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s deadline — abandoned`)),
          ms,
        );
      }),
    ]);
  };
  const ADAPTER_DEADLINE_MS = 5 * 60_000;   // parallel tier-1..3 adapters
  const SEEK_DEADLINE_MS    = 6 * 60_000;   // multi-keyword × 7 pages, worst-case legit ~4-5 min
  const ACTOR_DEADLINE_MS   = 8 * 60_000;   // Apify actor runs are minutes-long by nature
  if (bucketSkipScrape) {
    console.log(`[pipeline] stage 2 — skipped entirely (bucket fresh/locked); serving from bucket`);
  } else {
    await checkCancellation(runLogId);

    // Pre-filter BEFORE dispatch — identical skip logic/order to the old
    // sequential loop, just evaluated up front so only eligible adapters are
    // scheduled. isBlocked() reads are independent per-adapter Redis GETs,
    // safe to await in sequence here (cheap; not the bottleneck).
    const toRun: (typeof adapters)[number][] = [];
    for (const adapter of adapters) {
      if (!sourceEnabled(adapter.name)) {
        console.log(`[pipeline] stage 2 — ${adapter.name}: skipped (not in enabled_sources)`);
        continue;
      }
      // Apply vertical filter (default to all if not set).
      // "general" adapters (Adzuna, Jora) are sector-agnostic — they run for
      // every profile regardless of target_verticals.
      // Sector-specific adapters (tech, healthcare) only run when the profile
      // explicitly targets that vertical.
      if (profile.target_verticals && profile.target_verticals.length > 0) {
        if (adapter.vertical !== "general" && !profile.target_verticals.includes(adapter.vertical)) {
          console.log(`[pipeline] stage 2 — ${adapter.name}: skipped (vertical mismatch)`);
          continue;
        }
      }
      if (await isBlocked(adapter.name)) {
        console.log(`[pipeline] stage 2 — ${adapter.name}: blocked (3+ consecutive failures) — skipping`);
        continue;
      }
      toRun.push(adapter);
    }

    if (toRun.length > 0) {
      await setStage(runLogId, `Fetching from ${toRun.length} sources (up to ${STAGE2_CONCURRENCY} at a time)`);
      console.log(`[pipeline] stage 2 — fetching ${toRun.length} sources, concurrency ${STAGE2_CONCURRENCY}: ${toRun.map((a) => a.name).join(", ")}`);
      await Promise.allSettled(
        toRun.map((adapter) =>
          stage2Limit(async () => {
            try {
              const results = await withDeadline(
                adapter.fetchJobs(profile), ADAPTER_DEADLINE_MS, `${adapter.name} fetch`,
              );
              rawJobs.push(...results);
              sourcesRun.push(adapter.name);
              coverageSources.add(adapter.name);  // succeeded → eligible to mark slice covered
              await recordSuccess(adapter.name);
              console.log(`[pipeline]   ${adapter.name}: ${results.length} raw`);
            } catch (err) {
              console.error(`[pipeline] ${adapter.name} failed:`, err);
              const failures = await recordFailure(adapter.name);
              if (failures >= 3) {
                console.warn(`[pipeline] ${adapter.name}: ${failures} consecutive failures — will be skipped next run`);
              }
            }
          }),
        ),
      );
    }
  }
  // ── SEEK ──────────────────────────────────────────────────────────────────
  // Direct (got-scraping → seek.com.au HTML, free) vs Apify actor (paid),
  // SEEK listings: 'direct' (free, all tiers) → Apify actor fallback (Unlimited
  // only). Weekly/Monthly never spend paid Apify credits on listings.
  const seekEnabled = sourceEnabled("seek");
  const useActor = profile.seek_method === "actor";
  let seekDirectFailed = false;
  sourceMethods.seek = { enabled: seekEnabled };
  if (!seekEnabled) {
    console.log(`[pipeline] stage 2 — seek: skipped (not in enabled_sources)`);
    sourceMethods.seek.listings = "skipped";
  } else if (bucketSkipScrape) {
    console.log(`[pipeline] stage 2 — seek: skipped (bucket fresh/locked — serving from bucket)`);
    sourceMethods.seek.listings = "skipped";
  } else {
    await checkCancellation(runLogId);
    await setStage(runLogId, "Fetching from SEEK");
    if (useActor) {
      seekDirectFailed = true; // route straight to the actor block below
      if (seekAdapter && seekIntegration) {
        console.log(`[pipeline] seek: method=actor — using Apify actor`);
      } else {
        console.warn(`[pipeline] seek: method=actor but no working Apify integration — SEEK will be skipped`);
        sourceMethods.seek.listings = "skipped";
      }
    } else {
      try {
        const seekJobs = await withDeadline(
          seekDirectAdapter.fetchJobs(profile), SEEK_DEADLINE_MS, "seek-direct fetch",
        );
        rawJobs.push(...seekJobs);
        seekRawCount += seekJobs.length;
        sourcesRun.push("seek");
        sourceMethods.seek.listings = "direct";
        sourceMethods.seek.count    = seekJobs.length;
        console.log(`[pipeline]   seek (direct): ${seekJobs.length} raw (cost $0)`);
      } catch (err) {
        seekDirectFailed = true;
        console.warn(`[pipeline] seek-direct failed: ${err instanceof Error ? err.message : err}`);
        if (tier === "unlimited" && seekAdapter && seekIntegration) {
          console.warn(`[pipeline] seek-direct unavailable — falling back to Apify actor (unlimited tier)`);
        } else if (seekAdapter && seekIntegration) {
          console.warn(`[pipeline] seek-direct unavailable — Apify fallback skipped (${tier} tier); SEEK skipped this run`);
          sourceMethods.seek.listings = "skipped";
        } else {
          console.warn(`[pipeline] seek-direct unavailable and no Apify fallback configured — skipping SEEK`);
          sourceMethods.seek.listings = "skipped";
        }
      }
    }
  }

  // Apify listings actor: Unlimited-only. Runs when method=actor or direct threw,
  // the user is on the unlimited tier, and a working Apify integration exists.
  if (seekEnabled && seekDirectFailed && tier === "unlimited" && seekAdapter && seekIntegration) {
    await checkCancellation(runLogId);
    await setStage(runLogId, useActor ? "Fetching from SEEK (Apify)" : "Fetching from SEEK (Apify fallback)");
    try {
      const { jobs: seekJobs, costUsd } = await withDeadline(
        seekAdapter.fetchJobs(profile), ACTOR_DEADLINE_MS, "seek actor fetch",
      );
      rawJobs.push(...seekJobs);
      seekRawCount += seekJobs.length;
      if (!sourcesRun.includes("seek")) sourcesRun.push("seek");
      sourceMethods.seek!.listings = useActor ? "apify" : "apify_fallback";
      sourceMethods.seek!.count    = seekJobs.length;
      console.log(`[pipeline]   seek (apify ${useActor ? "active" : "fallback"}): ${seekJobs.length} raw (cost $${costUsd.toFixed(4)})`);

      // Persist updated spend immediately — even if rest of pipeline fails
      const newSpend = seekIntegration.quota_used_usd + costUsd;
      const newStatus = newSpend >= SEEK_MONTHLY_BUDGET_USD ? "quota_exceeded" : "valid";
      await db.from("user_integrations")
        .update({
          quota_used_usd:  newSpend,
          quota_used_requests: seekIntegration.quota_used_requests + seekJobs.length,
          last_used_at:    new Date().toISOString(),
          status:          newStatus,
          status_reason:   newStatus === "quota_exceeded"
            ? `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached`
            : null,
          updated_at:      new Date().toISOString(),
        })
        .eq("id", seekIntegration.id);
    } catch (err) {
      sourceMethods.seek!.listings = "apify_failed";
      console.error(`[pipeline] seek (apify ${useActor ? "active" : "fallback"}) failed: ${err instanceof Error ? err.message : err}`);
      // Mark as invalid so next run doesn't retry a broken token
      await db.from("user_integrations")
        .update({ status: "invalid", status_reason: err instanceof Error ? err.message : String(err), updated_at: new Date().toISOString() })
        .eq("id", seekIntegration.id);
    }
  }

  // SEEK counts as "covered" only if a scrape was actually ATTEMPTED this run
  // AND it either returned results or legitimately succeeded empty.
  if (shouldMarkSeekCovered({ seekEnabled, bucketSkipScrape, seekRawCount, seekDirectFailed })) {
    coverageSources.add("seek");
  }

  // Careerjet listings run in the adapters[] loop above via the free v4 API
  // (snippet). Full JDs are enriched later at stage 7c via the JD-fetcher
  // actor (residential) on survivors only — the funnel's narrow+expensive half.

  return rawJobs;
}
