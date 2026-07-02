// Pipeline orchestrator — runs all stages in order for a given profile.
//
// Stage  0: profile loaded
// Stage  1: run log created (status=running)
// Stage  2: source layer — parallel adapter calls
// Stage  3: normalise
// Stage  4: keyword pre-filter
// Stage  5: dedup L1 (url hash)
// Stage  6: dedup L2 (content fingerprint)
// Stage  7: dedup L3 FLAGGED OFF (DEDUP_L3_ENABLED=false)
// Stage  8: dedup L4 repost — placeholder
// Stage  9: expiry check (inside save)
// Stage 10: visa extraction — regex-first, AI fallback for ambiguous (gpt-4o-mini or claude-haiku)
// Stage 11: active link validation — HEAD requests top 50
// Stage 11b: distance — Nominatim geocode + OSRM driving distance per survivor
// Stage 12: idempotent upsert
// Stage 13: notify — Phase 6

import { createHash } from "crypto";
import { db } from "../db/client.js";
import { adapters } from "../sources/index.js";
import type { RawJob, SearchProfile } from "../sources/types.js";
import { normalise, canonicalUrl } from "./normalise.js";
import { applyKeywordFilter } from "./keywordFilter.js";
import { dedup } from "./dedup.js";
import { saveJobs } from "./save.js";
import {
  resolveSlices,
  recordCoverage,
  readCoverage,
  computeProfileLookback,
  sliceDeltaDays,
  acquireSliceLocks,
  releaseSliceLocks,
  COVERAGE_SOURCES,
  type CoverageSlice,
} from "./coverage.js";
import { bucketEnabled, upsertGlobalJobs, serveProfileFromBucket, evictStaleBucket, BUCKET_RETENTION_DAYS } from "./bucket.js";
import { postFetchFilter, excludeByDescription, formatExcludeBreakdown } from "./postFetchFilter.js";
import { startRunLog, finishRunLog, setStage } from "./runLog.js";
import { runLogContext } from "./logContext.js";
import { extractVisaInfo } from "../ai/visaExtractor.js";
import { classifySettings } from "../ai/settingClassifier.js";
import { applySettingFilter, formatSettingBreakdown } from "./settingFilter.js";
import { isBlocked, recordSuccess, recordFailure } from "./healthTracker.js";
import { sendPipelineFailureAlert } from "../notifications/errorAlert.js";
import { createSeekAdapter } from "../sources/seek.js";
import { seekDirectAdapter, enrichWithDirectJDs } from "../sources/seekDirect.js";
import { enrichCareerjetJDsViaActor } from "../sources/careerjetActor.js";
import { enrichWithAdzunaJDs } from "../sources/adzuna.js";
import { enrichAdzunaJDsViaActor } from "../sources/adzunaActor.js";
import { decryptApiKey } from "../lib/crypto.js";
import { autoAnalyzeBatch } from "../automation/triggerAutoAnalyze.js";
import { geocode, geocodeLocation, distanceFor, type LatLng } from "../lib/distance.js";

interface FullProfile extends SearchProfile {
  user_id: string;
  // Phase A automation config. min_initial_ats / min_final_ats were dropped
  // from search_profiles in migration 041 — global constants now (60 / 70)
  // enforced by cv-backend AnalyzeRequest defaults.
  automation_enabled:      boolean;
  // Migration 048 — distance origin. home_address is what the user typed.
  // home_lat/home_lng are filled lazily on the next run after the address
  // changes (the actions layer resets them to null on edit).
  home_address: string | null;
  home_lat:     number | null;
  home_lng:     number | null;
}

// ── Integration types ──────────────────────────────────────────────────────────
interface UserIntegration {
  id:                  string;
  encrypted_api_key:   string;
  status:              string;
  quota_used_usd:      number;
  quota_used_requests: number;
  quota_period_start:  string;  // date as ISO string "YYYY-MM-DD"
  is_enabled:          boolean;
  config:              Record<string, unknown>;
}

const SEEK_MONTHLY_BUDGET_USD = 5.0;   // Apify free tier

/**
 * Load an Apify integration row for the running profile.
 *
 * Resolution order:
 *   1. The profile owner's own integration (legacy BYO-Apify support).
 *   2. Fallback: an admin/founder's integration (the platform/admin model —
 *      one paid Apify token serves every user). Picked deterministically
 *      (first valid, enabled, lowest created_at).
 *
 * Returns null only if BOTH lookups fail. The shared spend is accumulated
 * on whichever row we used (admin row when on the fallback), so the admin's
 * existing budget UI shows total platform Apify usage.
 */
async function loadApifyIntegration(userId: string): Promise<UserIntegration | null> {
  const COLS = "id, encrypted_api_key, status, quota_used_usd, quota_used_requests, quota_period_start, is_enabled, config";
  const own = await db
    .from("user_integrations")
    .select(COLS)
    .eq("user_id", userId)
    .eq("provider", "apify")
    .maybeSingle();
  if (own.data) return own.data as UserIntegration;

  // Fallback: any founder/admin's Apify integration (platform model).
  const { data: admins } = await db
    .from("users")
    .select("id")
    .in("role", ["founder", "admin"]);
  const adminIds = (admins ?? []).map((u: { id: string }) => u.id);
  if (adminIds.length === 0) return null;

  const { data: row } = await db
    .from("user_integrations")
    .select(COLS)
    .in("user_id", adminIds)
    .eq("provider", "apify")
    .eq("is_enabled", true)
    .eq("status", "valid")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return row as UserIntegration | null;
}

type SubscriptionTier = "weekly" | "monthly" | "unlimited";

interface PlatformSources {
  tier:            SubscriptionTier;
  enabled_sources: string[];
  adzuna_method:   "api" | "direct";
  seek_method:     "direct" | "actor";
}

function planToTier(planId: string | null | undefined, status: string | null | undefined): SubscriptionTier {
  if (status === "comp") return "unlimited";
  if (planId === "monthly")   return "monthly";
  if (planId === "unlimited") return "unlimited";
  return "weekly";  // trial, null, unknown → free tier
}

/**
 * Load the per-subscription-tier source config (migration 064). Resolves the
 * user's current plan → tier row in platform_source_tiers → source settings.
 * Founders/admins always receive the unlimited tier. Falls back to weekly (free)
 * defaults if the DB is unavailable or the row is missing.
 */
async function loadPlatformSources(userId: string): Promise<PlatformSources> {
  const freeFallback: PlatformSources = {
    tier:            "weekly",
    enabled_sources: ["adzuna", "seek", "careerjet"],
    adzuna_method:   "api",
    seek_method:     "direct",
  };
  try {
    let tier: SubscriptionTier = "weekly";

    // Founders/admins always get the unlimited tier (no Stripe sub needed).
    const { data: userRow } = await db
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    if (userRow?.role === "founder" || userRow?.role === "admin") {
      tier = "unlimited";
    } else {
      const { data: sub } = await db
        .from("subscriptions")
        .select("plan_id, status")
        .eq("user_id", userId)
        .maybeSingle();
      tier = planToTier(sub?.plan_id as string | null, sub?.status as string | null);
    }

    const { data } = await db
      .from("platform_source_tiers")
      .select("enabled_sources, adzuna_method, seek_method")
      .eq("tier", tier)
      .maybeSingle();

    if (!data) {
      console.warn(`[pipeline] platform_source_tiers row missing for tier=${tier}, using free defaults`);
      return freeFallback;
    }
    console.log(`[pipeline] sources tier=${tier} (plan lookup for user ${userId})`);
    return {
      tier,
      enabled_sources: (data.enabled_sources as string[] | null) ?? freeFallback.enabled_sources,
      adzuna_method:   (data.adzuna_method as "api" | "direct" | null) ?? freeFallback.adzuna_method,
      seek_method:     (data.seek_method as "direct" | "actor" | null) ?? freeFallback.seek_method,
    };
  } catch (err) {
    console.warn(`[pipeline] platform_source_tiers load failed, using free defaults: ${err instanceof Error ? err.message : err}`);
    return freeFallback;
  }
}

/** Reset quota counters when we've rolled into a new calendar month. */
async function maybeResetQuota(integration: UserIntegration): Promise<UserIntegration> {
  const currentPeriod = new Date().toISOString().slice(0, 7);      // "YYYY-MM"
  const storedPeriod  = integration.quota_period_start.slice(0, 7);

  if (storedPeriod >= currentPeriod) return integration;  // still in same month

  // New month — reset spend
  const newPeriodStart = `${currentPeriod}-01`;
  await db
    .from("user_integrations")
    .update({
      quota_used_usd:      0,
      quota_used_requests: 0,
      quota_period_start:  newPeriodStart,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", integration.id);

  return { ...integration, quota_used_usd: 0, quota_used_requests: 0, quota_period_start: newPeriodStart };
}

async function loadProfile(profileId: string): Promise<FullProfile | null> {
  const { data } = await db
    .from("search_profiles")
    .select("id, user_id, keywords, location, visa_filter_mode, working_rights, target_verticals, setting_filter, adzuna_title_keywords, adzuna_exact_phrase, adzuna_any_keywords, adzuna_exclude_keywords, adzuna_salary_min, adzuna_salary_max, adzuna_contract_type, adzuna_hours, adzuna_distance_km, adzuna_max_days_old, exclude_title_keywords, must_include_phrases, automation_enabled, enabled_sources, seek_method, adzuna_method, home_address, home_lat, home_lng")
    .eq("id", profileId)
    .single();
  return data as FullProfile | null;
}

async function checkCancellation(runLogId: string): Promise<void> {
  const { data } = await db.from("run_logs").select("status").eq("id", runLogId).maybeSingle();
  if (data?.status === "failed") {
    throw new Error("Cancelled by user");
  }
}


export async function runPipeline(profileId: string, trigger: "manual" | "auto" = "auto", fullRefresh = false): Promise<void> {
  console.log(`\n[pipeline] ─── starting run for profile ${profileId} (trigger=${trigger}${fullRefresh ? ", full refresh" : ""}) ───`);

  // Stage 0: load profile
  const profile = await loadProfile(profileId);
  if (!profile) {
    console.error(`[pipeline] profile ${profileId} not found — aborting`);
    return;
  }

  profile.is_manual_run = trigger === "manual";

  // Source selection + per-source method are tier-gated (platform_source_tiers,
  // migration 064). The user's subscription plan determines the tier row. Override
  // the profile's (vestigial) columns so all downstream stage-2 logic reads the
  // tier-appropriate choices.
  const platformSources = await loadPlatformSources(profile.user_id);
  const tier = platformSources.tier;
  profile.enabled_sources = platformSources.enabled_sources;
  profile.adzuna_method   = platformSources.adzuna_method;
  profile.seek_method     = platformSources.seek_method;
  console.log(`[pipeline] sources (tier-gated): ${platformSources.enabled_sources.join(", ")} · adzuna=${platformSources.adzuna_method} · seek=${platformSources.seek_method} · tier=${tier}`);

  // Concurrency guard — two SQL operations, both done by Postgres so timezone
  // format differences between JS (.toISOString → "Z") and Postgres ("+00:00")
  // never affect the comparison.
  //
  // Normal pipeline ceiling: ~5 min (SEEK actor is the slow one at 300s).
  // Stale threshold: 15 min — if a run is still "running" after that, the worker
  // crashed or was OOM-killed and finishRunLog never ran.
  const STALE_MINUTES = 15;
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

  // Step 1: expire anything that's been "running" for > STALE_MINUTES.
  // Postgres does the timestamp comparison — no JS string-vs-timezone issues.
  const { data: expired, error: expireErr } = await db
    .from("run_logs")
    .update({
      status:        "failed",
      finished_at:   new Date().toISOString(),
      error_message: `Stale lock auto-expired after ${STALE_MINUTES} min (worker crash or OOM kill)`,
    })
    .eq("profile_id", profileId)
    .eq("status", "running")
    .lt("started_at", staleThreshold)   // Postgres TIMESTAMPTZ < — correct always
    .select("id");

  if (expireErr) {
    console.warn(`[pipeline] stale-expire failed: ${expireErr.message}`);
  } else if (expired && expired.length > 0) {
    console.log(`[pipeline] expired ${expired.length} stale lock(s): ${expired.map((r) => r.id).join(", ")}`);
  }

  // Step 2: check for a genuinely active run (started within the last STALE_MINUTES).
  const { data: activeRuns } = await db
    .from("run_logs")
    .select("id, started_at")
    .eq("profile_id", profileId)
    .eq("status", "running")
    .gte("started_at", staleThreshold);  // only recent ones — Postgres comparison

  if (activeRuns && activeRuns.length > 0) {
    console.log(`[pipeline] profile ${profileId} already running (run_log ${activeRuns[0].id}, started ${activeRuns[0].started_at}) — skipping`);
    return;
  }

  // Compute the lookback window from the last completed run, then apply it to
  // all date-aware adapters (Adzuna, SEEK, Careerjet). Avoids re-fetching jobs
  // the dedup would throw away anyway.
  //   - First run (cold start): fetch DEEP — 28 days back, more pages.
  //   - Subsequent runs (incremental): only what's new since last success
  //     + 1 day buffer for timing jitter, capped at 30 days.
  const FIRST_RUN_LOOKBACK_DAYS = 28;
  const { data: lastRun } = await db
    .from("run_logs")
    .select("started_at")
    .eq("profile_id", profileId)
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const isFirstRun = !lastRun;
  // A user-requested "full refresh" re-runs the deep cold-start window even
  // when prior runs exist — for when the incremental 2-3 day window is too
  // narrow and the user wants the whole backlog again.
  const deepRun = isFirstRun || fullRefresh;
  let lookbackDays: number;
  if (deepRun) {
    lookbackDays = FIRST_RUN_LOOKBACK_DAYS;
    const why = isFirstRun ? "first run — deep cold-start backfill" : "full refresh requested";
    console.log(`[pipeline] lookback: ${lookbackDays}d (${why})`);
  } else {
    // Incremental: fetch only what's new since last success + 1 day buffer
    const daysSince = Math.ceil(
      (Date.now() - new Date(lastRun!.started_at).getTime()) / 86_400_000
    );
    lookbackDays = Math.min(daysSince + 1, 30);
    console.log(`[pipeline] lookback: ${lookbackDays}d (incremental — last run ${daysSince}d ago)`);
  }
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
        : Array.from(COVERAGE_SOURCES);
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
          if (claimed === 0) {
            // Another in-flight refresh already owns all stale slices → don't
            // double-scrape; serve the (about-to-be-refreshed) bucket.
            bucketSkipScrape = true;
            console.log(`[pipeline] bucket: ${stale.length} stale slices locked by another refresh — skip scrape, serve from bucket`);
          } else {
            bucketLockedSlices = stale;
            console.log(`[pipeline] bucket lookback: ${lookbackDays}d (claimed ${claimed}/${stale.length} stale slices)`);
          }
        } else {
          // Cold slices present → scrape; still claim existing locks for hygiene.
          await acquireSliceLocks(stale.filter((s) => coverage.has(key(s))));
          bucketLockedSlices = stale;
          console.log(`[pipeline] bucket lookback: ${lookbackDays}d (${cold.length} cold + ${stale.length - cold.length} stale slices — scraping)`);
        }
      }
    }
  }

  // Adzuna reads adzuna_max_days_old; SEEK + Careerjet read lookback_days /
  // is_first_run. Set all three so every date-aware adapter follows suit.
  // A full refresh also runs sources at first-run depth (more pages).
  profile.adzuna_max_days_old = lookbackDays;
  profile.lookback_days       = lookbackDays;
  profile.is_first_run        = deepRun;

  // ── Load SEEK integration (per-user Apify token) ──────────────────────────
  // Each user brings their own $5/month Apify free tier — costs nothing to the app.
  // If not connected, not valid, or quota exhausted → seekAdapter stays null,
  // the pipeline runs without SEEK (Adzuna + Greenhouse + Jora still run).
  let seekIntegration: UserIntegration | null = null;
  let seekAdapter: ReturnType<typeof createSeekAdapter> | null = null;
  let seekToken: string | null = null;  // kept for post-dedup JD enrichment

  try {
    const raw = await loadApifyIntegration(profile.user_id);
    if (raw && raw.is_enabled && raw.status === "valid") {
      seekIntegration = await maybeResetQuota(raw);
      const remaining = SEEK_MONTHLY_BUDGET_USD - seekIntegration.quota_used_usd;
      if (remaining > 0.01) {
        seekToken    = decryptApiKey(seekIntegration.encrypted_api_key);
        seekAdapter  = createSeekAdapter(seekToken);
        console.log(`[pipeline] SEEK adapter ready — $${remaining.toFixed(2)} remaining this month`);
      } else {
        console.log(`[pipeline] SEEK skipped — Apify monthly budget exhausted ($${SEEK_MONTHLY_BUDGET_USD})`);
        // Mark quota_exceeded so the UI can show the right state
        await db.from("user_integrations")
          .update({ status: "quota_exceeded", status_reason: `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached`, updated_at: new Date().toISOString() })
          .eq("id", seekIntegration.id);
      }
    } else if (raw) {
      console.log(`[pipeline] SEEK skipped — integration status: ${raw.status}`);
    } else {
      console.log(`[pipeline] SEEK skipped — no Apify integration configured`);
    }
  } catch (err) {
    // Never let integration loading crash the whole pipeline
    console.warn(`[pipeline] SEEK integration load failed: ${err instanceof Error ? err.message : err}`);
  }

  // Stage 1: start run log
  let runLogId: string;
  try {
    runLogId = await startRunLog(profileId);
  } catch (err) {
    console.error("[pipeline] failed to create run log:", err);
    return;
  }

  // Bind the rest of this pipeline (and every async call it spawns) to this
  // run's log context. Patched console.log/warn/error in logContext.ts will
  // mirror each line into run_logs.log_lines for the live console UI.
  runLogContext.enterWith({ runLogId });

  const sourcesRun: string[] = [];
  // Sources that actually SUCCEEDED this run (returned results, or completed
  // without a fetch failure). Only these update search_coverage — so a source
  // that errored/403'd and yielded nothing is NOT marked "fresh" and gets
  // retried next run instead of being cached as covered.
  const coverageSources = new Set<string>();
  let seekRawCount = 0;
  let jobsFetched = 0;
  let jobsAfterDedup = 0;
  let jobsSaved = 0;
  let jobsDeduped = 0;
  let sourcesSaved: Record<string, number> = {};

  // Per-run source method tracking — persisted to run_logs.source_methods so
  // admins can diagnose paid-tier source failures without grepping log_lines.
  const sourceMethods: {
    tier: string;
    seek?:      { enabled: boolean; listings?: string; jd?: string; merged?: number; fetched?: number; count?: number };
    adzuna?:    { enabled: boolean; method?: string; enrichment?: string; merged?: number; fetched?: number };
    careerjet?: { enabled: boolean; method?: string };
  } = { tier };

  try {
    // Per-profile source selection (Migration 041): null/empty = all sources.
    const enabledSources = profile.enabled_sources ?? null;
    const sourceEnabled = (name: string): boolean =>
      !enabledSources || enabledSources.length === 0 || enabledSources.includes(name);

    // Stage 2: source layer
    const rawJobs: RawJob[] = [];
    if (bucketSkipScrape) {
      console.log(`[pipeline] stage 2 — skipped entirely (bucket fresh/locked); serving from bucket`);
    }
    for (const adapter of adapters) {
      if (bucketSkipScrape) break;
      await checkCancellation(runLogId);

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
      try {
        console.log(`[pipeline] stage 2 — fetching: ${adapter.name}`);
        await setStage(runLogId, `Fetching from ${adapter.name}`);
        const results = await adapter.fetchJobs(profile);
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
          const seekJobs = await seekDirectAdapter.fetchJobs(profile);
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
        const { jobs: seekJobs, costUsd } = await seekAdapter.fetchJobs(profile);
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

    // SEEK counts as "covered" only if it returned results OR direct succeeded
    // (legitimately empty). A 403→0-item-actor chain yields nothing and is NOT
    // marked covered, so the slice stays stale and SEEK is retried next run
    // instead of being cached as fresh for the TTL window.
    if (seekEnabled && (seekRawCount > 0 || !seekDirectFailed)) coverageSources.add("seek");

    // Careerjet listings run in the adapters[] loop above via the free v4 API
    // (snippet). Full JDs are enriched later at stage 7c via the JD-fetcher
    // actor (residential) on survivors only — the funnel's narrow+expensive half.

    jobsFetched = rawJobs.length;
    console.log(`[pipeline] stage 2 done — total raw: ${jobsFetched}`);
    await setStage(runLogId, "Filtering & deduplicating");

    // Stage 3: L1 early URL dedup
    // Hash the canonical URL (same transform dedup.ts uses) so the DB lookup
    // actually matches rows saved by previous runs.
    const rawHashes = new Set<string>();
    const uniqueRawJobs: RawJob[] = [];
    const hashedRawJobs = rawJobs.map(job => {
      return { job, hash: createHash("sha256").update(canonicalUrl(job.url)).digest("hex") };
    });
    
    // Batch query DB for these hashes
    const urlHashesToQuery = hashedRawJobs.map(h => h.hash);
    const { data: existingJobs } = await db
      .from("jobs")
      .select("url_hash")
      .eq("profile_id", profileId)
      .in("url_hash", urlHashesToQuery);

    const existingHashSet = new Set((existingJobs || []).map(j => j.url_hash));

    let earlyL1Dropped = 0;
    for (const { job, hash } of hashedRawJobs) {
      if (existingHashSet.has(hash) || rawHashes.has(hash)) {
        earlyL1Dropped++;
      } else {
        rawHashes.add(hash);
        uniqueRawJobs.push(job);
      }
    }
    
    jobsDeduped += earlyL1Dropped;
    console.log(`[pipeline] stage 3 — L1 early drop: ${earlyL1Dropped} duplicates removed, ${uniqueRawJobs.length} remaining`);

    // Stage 3b — cross-profile dedup (skip)
    // If a URL already exists in ANY other profile of the same user, drop it
    // entirely from this profile's feed. Profiles act as filter views: a job
    // a user has already seen elsewhere should not reappear in another profile.
    const newRawJobs: RawJob[] = [];

    const { data: siblingProfiles } = await db
      .from("search_profiles")
      .select("id")
      .eq("user_id", profile.user_id)
      .neq("id", profileId);

    const siblingIds = (siblingProfiles ?? []).map((p) => p.id);

    if (siblingIds.length > 0 && uniqueRawJobs.length > 0) {
      const hashByJob = uniqueRawJobs.map((j) => ({
        job:  j,
        hash: createHash("sha256").update(canonicalUrl(j.url)).digest("hex"),
      }));

      const { data: existingRows } = await db
        .from("jobs")
        .select("url_hash")
        .in("profile_id", siblingIds)
        .in("url_hash", hashByJob.map((x) => x.hash));

      const seenInSiblings = new Set(
        (existingRows ?? []).map((r) => r.url_hash as string)
      );

      let droppedCrossProfile = 0;
      for (const { job, hash } of hashByJob) {
        if (seenInSiblings.has(hash)) {
          droppedCrossProfile++;
        } else {
          newRawJobs.push(job);
        }
      }

      jobsDeduped += droppedCrossProfile;
      console.log(
        `[pipeline] stage 3b — cross-profile dedup: ${droppedCrossProfile} dropped ` +
        `(already in sibling profile), ${newRawJobs.length} remain`
      );
    } else {
      newRawJobs.push(...uniqueRawJobs);
      if (siblingIds.length === 0) {
        console.log(`[pipeline] stage 3b — first profile for user, no cross-profile dedup`);
      }
    }

    // Stage 4a: normalise — only truly new URLs from here on
    const normalised = newRawJobs.map(normalise);

    // Stage 4b: keyword filter — title-only with optional smart-filter rescue.
    // Phrase source: profile.must_include_phrases if set, else profile.keywords.
    // Teaser rescue activates only when must_include_phrases is non-empty.
    const filtered = applyKeywordFilter(normalised, profile);
    const usingSmartFilter = (profile.must_include_phrases ?? []).filter((s) => s && s.trim()).length > 0;
    console.log(
      `[pipeline] stage 4b — keyword filter (title-only` +
      `${usingSmartFilter ? " + teaser rescue" : ""}): ` +
      `${filtered.length} kept, ${normalised.length - filtered.length} dropped` +
      `${usingSmartFilter ? ` (smart filter: ${(profile.must_include_phrases ?? []).join(", ")})` : ""}`,
    );
    if (normalised.length > 0 && filtered.length === 0) {
      console.warn(
        `[pipeline] ⚠ stage 4b dropped ALL ${normalised.length} jobs — your "Title must include any of" ` +
        `(${(usingSmartFilter ? (profile.must_include_phrases ?? []) : (profile.keywords ?? [])).join(", ")}) ` +
        `matched no title or teaser. Loosen it or add more phrases.`,
      );
    }

    // Stage 4c: post-fetch smart filter — applies user's title/description rules
    // universally across ALL sources (not just Adzuna).
    // This is where "title must contain", "exclude from title",
    // and "exclude from description" rules are enforced.
    const { kept: smartFiltered, droppedTitleMissing, droppedTitleExcluded, droppedDescExcluded, descExcludedByPhrase } =
      postFetchFilter(filtered, profile);
    console.log(
      `[pipeline] stage 4c — smart filter: ${smartFiltered.length} kept` +
      ` (title missing required: ${droppedTitleMissing}` +
      `, title excluded: ${droppedTitleExcluded}` +
      `, desc excluded: ${droppedDescExcluded}${formatExcludeBreakdown(descExcludedByPhrase)})`
    );
    if (filtered.length > 0 && smartFiltered.length === 0) {
      console.warn(
        `[pipeline] ⚠ stage 4c dropped ALL ${filtered.length} jobs — check your filter rules` +
        `${droppedDescExcluded > 0 ? ` ("Description must NOT contain"${formatExcludeBreakdown(descExcludedByPhrase)})` : ""}.`,
      );
    }

    // Stages 5+6: dedup L1 + L2 (strong drop + weak flag)
    const { kept: dedupKept, l1Dropped, l2Dropped, l2WeakMarked } = await dedup(smartFiltered, profileId);
    jobsAfterDedup = dedupKept.length;
    jobsDeduped += l1Dropped + l2Dropped;
    console.log(
      `[pipeline] stage 5+6 — dedup: ${dedupKept.length} kept ` +
      `(L1 ${l1Dropped} + L2-strong ${l2Dropped} dropped, ${l2WeakMarked} marked possible_duplicate)`
    );

    // ── Stage 7: SEEK JD enrichment (free direct only, all tiers) ───────────────
    // Fetch full job descriptions for SEEK survivors only — i.e. jobs that have
    // already passed keyword + smart + dedup filters. Free direct path only;
    // the Apify JD-fetcher fallback has been removed (two paid actors max:
    // SEEK listings actor + Adzuna JD actor, both Unlimited-only).
    let kept = dedupKept;
    const seekSurvivors = dedupKept.some((j) => j.source === "seek");
    if (seekSurvivors) {
      await setStage(runLogId, "Fetching full SEEK descriptions");
      // No cap — every SEEK survivor gets a full JD. SEEK direct enrichment is
      // free (curl_cffi, $0), so the only cost is wall-clock; "full JD for all
      // saved jobs" matters more than shaving a few seconds.
      const jdCap = dedupKept.length;
      try {
        const { jobs: enriched, merged, fetched } = await enrichWithDirectJDs(dedupKept, jdCap);
        kept = enriched;
        sourceMethods.seek ??= { enabled: true };
        sourceMethods.seek.jd      = merged > 0 ? "direct" : "teaser";
        sourceMethods.seek.merged  = merged;
        sourceMethods.seek.fetched = fetched;
        console.log(`[pipeline] stage 7 — SEEK JD direct: ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
      } catch (err) {
        sourceMethods.seek ??= { enabled: true };
        sourceMethods.seek.jd = "teaser";
        console.warn(`[pipeline] stage 7 — SEEK JD direct threw: ${err instanceof Error ? err.message : err}; survivors keep teasers`);
      }
    }

    // ── Stage 7c: Careerjet full-JD enrichment ─────────────────────────────────
    // The funnel's narrow+expensive half: listings came free from the v4 API;
    // now fetch full JDs for the Careerjet *survivors* via the careerjet-jd-fetcher
    // actor (residential — datacenter is Turnstile-blocked). No-ops when
    // CAREERJET_ACTOR_ID is unset or no Apify token → survivors keep the snippet.
    const careerjetSurvivors = kept.some((j) => j.source === "careerjet");
    const careerjetEnabled = sourceEnabled("careerjet");
    sourceMethods.careerjet = { enabled: careerjetEnabled, method: "api" };
    if (careerjetSurvivors && process.env.CAREERJET_ACTOR_ID && seekToken && seekIntegration) {
      await setStage(runLogId, "Fetching full Careerjet descriptions");
      try {
        const { jobs: enriched, merged, fetched, costUsd } =
          await enrichCareerjetJDsViaActor(kept, seekToken);
        kept = enriched;
        console.log(`[pipeline] stage 7c — Careerjet JD (actor): ${merged}/${fetched} full descriptions merged (cost $${costUsd.toFixed(4)})`);
        // Persist spend on the shared Apify integration (re-read to avoid
        // clobbering the SEEK block's earlier increment in the same run).
        if (costUsd > 0) {
          try {
            const { data: fresh } = await db.from("user_integrations")
              .select("quota_used_usd").eq("id", seekIntegration.id).single();
            const baseSpend = fresh?.quota_used_usd ?? seekIntegration.quota_used_usd;
            const newSpend  = baseSpend + costUsd;
            await db.from("user_integrations").update({
              quota_used_usd: newSpend,
              last_used_at:   new Date().toISOString(),
              status:         newSpend >= SEEK_MONTHLY_BUDGET_USD ? "quota_exceeded" : "valid",
              status_reason:  newSpend >= SEEK_MONTHLY_BUDGET_USD ? `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached` : null,
              updated_at:     new Date().toISOString(),
            }).eq("id", seekIntegration.id);
          } catch (e) {
            console.warn(`[pipeline] careerjet spend update failed (non-fatal): ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (err) {
        console.warn(`[pipeline] stage 7c — Careerjet JD threw: ${err instanceof Error ? err.message : err}`);
      }
    } else if (careerjetSurvivors) {
      console.log(`[pipeline] stage 7c — Careerjet JD: skipped (CAREERJET_ACTOR_ID unset or no Apify token) — keeping v4 API snippet`);
    }

    // ── Stage 7d: Adzuna full-JD enrichment (Unlimited only, via adzuna_method) ──
    // 'api' → skip; teasers (~600 chars) carry forward.
    // 'direct' + ADZUNA_ACTOR_ID + Apify token → fetch full JDs via the
    //   adzuna-jd-fetcher actor on residential proxy (Unlimited tier only).
    // 'direct' without actor → legacy curl-from-Fly path (rate-limited in prod;
    //   kept for local-dev only).
    const adzunaSurvivors = kept.some((j) => j.source === "adzuna");
    const useAdzunaDirect = profile.adzuna_method === "direct";
    const adzunaEnabled = sourceEnabled("adzuna");
    sourceMethods.adzuna = { enabled: adzunaEnabled, method: profile.adzuna_method ?? "api" };
    if (adzunaSurvivors && useAdzunaDirect && process.env.ADZUNA_ACTOR_ID && seekToken && seekIntegration) {
      await setStage(runLogId, "Fetching full Adzuna descriptions");
      try {
        const { jobs: enriched, merged, fetched, costUsd } =
          // No per-run cap — full JD for every Adzuna survivor. The monthly
          // SEEK_MONTHLY_BUDGET_USD guard below bounds total actor spend, and
          // Adzuna survivors per run are few (most lose dedup to SEEK/agedcare).
          await enrichAdzunaJDsViaActor(kept, seekToken, kept.length);
        kept = enriched;
        sourceMethods.adzuna.enrichment = "actor";
        sourceMethods.adzuna.merged     = merged;
        sourceMethods.adzuna.fetched    = fetched;
        console.log(`[pipeline] stage 7d — Adzuna JD (actor): ${merged}/${fetched} full descriptions merged (cost $${costUsd.toFixed(4)})`);
        if (costUsd > 0) {
          try {
            const { data: fresh } = await db.from("user_integrations")
              .select("quota_used_usd").eq("id", seekIntegration.id).single();
            const baseSpend = fresh?.quota_used_usd ?? seekIntegration.quota_used_usd;
            const newSpend  = baseSpend + costUsd;
            await db.from("user_integrations").update({
              quota_used_usd: newSpend,
              last_used_at:   new Date().toISOString(),
              status:         newSpend >= SEEK_MONTHLY_BUDGET_USD ? "quota_exceeded" : "valid",
              status_reason:  newSpend >= SEEK_MONTHLY_BUDGET_USD ? `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached` : null,
              updated_at:     new Date().toISOString(),
            }).eq("id", seekIntegration.id);
          } catch (e) {
            console.warn(`[pipeline] adzuna spend update failed (non-fatal): ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (err) {
        sourceMethods.adzuna.enrichment = "actor_failed_teaser";
        console.warn(
          `[pipeline] stage 7d — Adzuna JD actor failed (${err instanceof Error ? err.message : err}); ` +
          `falling back to API teasers (no full-JD enrichment this run)`,
        );
      }
    } else if (adzunaSurvivors && useAdzunaDirect) {
      await setStage(runLogId, "Fetching full Adzuna descriptions");
      // No cap — full JD for every Adzuna survivor (consistent with the actor
      // branch). This legacy curl-from-Fly path is 429-rate-limited in prod so
      // it's dev-only, but uncapping keeps the two 'direct' branches aligned.
      const jdCap = kept.length;
      try {
        const { jobs: enriched, merged, fetched } = await enrichWithAdzunaJDs(kept, jdCap);
        kept = enriched;
        sourceMethods.adzuna.enrichment = "direct_curl";
        sourceMethods.adzuna.merged     = merged;
        sourceMethods.adzuna.fetched    = fetched;
        console.log(`[pipeline] stage 7d — Adzuna JD (direct curl): ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
      } catch (err) {
        sourceMethods.adzuna.enrichment = "direct_curl_failed_teaser";
        console.warn(`[pipeline] stage 7d — Adzuna JD direct threw: ${err instanceof Error ? err.message : err}`);
      }
    } else if (adzunaSurvivors) {
      sourceMethods.adzuna.enrichment = "none";
      console.log(`[pipeline] stage 7d — Adzuna JD: skipped (adzuna_method='api', using API teasers only)`);
    }

    // Adzuna only contributes new desc text to re-scan when 'direct' mode
    // actually enriched something — under 'api' mode the teaser is unchanged
    // and we'd just re-run the same scan stage 4c did.
    const adzunaEnriched = adzunaSurvivors && useAdzunaDirect;
    if (seekSurvivors || careerjetSurvivors || adzunaEnriched) {
      // ── Stage 7b: re-run desc-exclusion against the FULL JD ────────────────
      // The first pass at stage 4c could only see teasers for SEEK. Now that we
      // have full JDs, dropped phrases that lived deep in the description are
      // catchable.
      const { kept: afterDesc, dropped: droppedNow, byPhrase: descByPhrase } = excludeByDescription(kept, profile);
      if (droppedNow > 0) {
        console.log(`[pipeline] stage 7b — desc-exclusion against full JD: ${droppedNow} dropped, ${afterDesc.length} remain${formatExcludeBreakdown(descByPhrase)}`);
        if (afterDesc.length === 0) {
          console.warn(
            `[pipeline] ⚠ stage 7b dropped ALL remaining jobs against the full JD — ` +
            `your "Description must NOT contain"${formatExcludeBreakdown(descByPhrase)} is matching every survivor.`,
          );
        }
        kept = afterDesc;
        jobsAfterDedup = kept.length;
      }
    }

    // Stage 10a: visa extraction — regex-first, AI only for ambiguous cases
    // Runs on the full description of each new job (no truncation).
    // Sets sponsorship_status, citizen_pr_only, visa_extracted_text on each job.
    let visaReady = kept;
    if (kept.length > 0) {
      console.log(`[pipeline] stage 10a — extracting visa info for ${kept.length} jobs`);
      await setStage(runLogId, `Extracting visa info (${kept.length} jobs)`);
      const visaMap = await extractVisaInfo(kept);
      visaReady = kept.map((job) => {
        const info = visaMap.get(job.url_hash);
        if (!info) return job;
        return {
          ...job,
          sponsorship_status: info.sponsorship_status,
          citizen_pr_only: info.citizen_pr_only,
          visa_extracted_text: info.visa_extracted_text,
          // Keep visa_likelihood for sort compat — derived from binary result
          // (saved separately below via update, as it lives on the jobs table)
        };
      });
    }

    // Stage 10c: work-setting classification — keyword-first, AI only for
    // ambiguous care jobs (env SETTING_CLASSIFIER_AI). A shared, once-per-job
    // FACT (like visa): it flows into global_jobs and is reused by every profile.
    // The per-profile setting FILTER is separate (stage 10d / bucket serve).
    // Runs on EVERY fetched job before the bucket write so the shared bucket
    // always carries a setting label — the classifier skips non-care JDs cheaply
    // (a regex gate) and the AI tier only fires for ambiguous CARE jobs, so
    // classifying non-healthcare runs costs effectively nothing.
    let settingReady = visaReady;
    if (visaReady.length > 0) {
      await setStage(runLogId, `Classifying work setting (${visaReady.length} jobs)`);
      const settingMap = await classifySettings(visaReady);
      settingReady = visaReady.map((job) => {
        const info = settingMap.get(job.url_hash);
        if (!info) return job;
        return {
          ...job,
          setting_category: info.setting_category,
          setting_confidence: info.setting_confidence,
          setting_evidence: info.setting_evidence,
        };
      });
    }

    // Stage 10b: working rights filter
    // Drop jobs that conflict with the user's working rights situation.
    // "needs_sponsorship" → drop jobs that explicitly say no sponsorship or citizens/PR only.
    // "pr_citizen" and "any" → no filtering, all jobs saved (just different labels shown).
    let toSave = settingReady;
    if (profile.working_rights === "needs_sponsorship") {
      const beforeWR = toSave.length;
      toSave = toSave.filter((j) =>
        j.sponsorship_status !== "no" && j.citizen_pr_only !== true
      );
      const droppedWR = beforeWR - toSave.length;
      console.log(`[pipeline] stage 10b — working rights filter: ${droppedWR} dropped (explicit no-sponsorship / PR-citizen-only), ${toSave.length} remaining`);
    } else {
      console.log(`[pipeline] stage 10b — working rights: "${profile.working_rights ?? "any"}" — no filter applied`);
    }

    // Stage 10d: work-setting filter (per-profile). LEGACY (non-bucket) path
    // ONLY — in bucket mode the identical filter runs inside serveProfileFromBucket
    // AFTER the shared bucket write. Filtering `toSave` here would drop jobs from
    // the shared global_jobs bucket that OTHER profiles want (bucket poisoning).
    if (!bucketEnabled() && (profile.setting_filter?.length ?? 0) > 0) {
      const { kept: afterSetting, dropped, byCategory } = applySettingFilter(toSave, profile);
      toSave = afterSetting;
      console.log(`[pipeline] stage 10d — setting filter: ${dropped} dropped, ${toSave.length} remaining${formatSettingBreakdown(byCategory)}`);
    }

    // Stage 11b: distance computation (Migration 048).
    //   - Skip entirely when the profile has no home_address.
    //   - On the first run after the user enters/changes their address,
    //     home_lat/home_lng are null — geocode it once and persist.
    //   - Then resolve a driving distance for each survivor via Nominatim +
    //     OSRM (free public endpoints, 1 req/sec to Nominatim, in-process
    //     cache dedupes repeated location strings). OSRM "no route" falls
    //     back to Haversine — flagged on the row via distance_method so the
    //     UI can show a tilde.
    let homeOrigin: LatLng | null = null;
    if (profile.home_address && profile.home_address.trim()) {
      if (profile.home_lat != null && profile.home_lng != null) {
        homeOrigin = { lat: profile.home_lat, lng: profile.home_lng };
      } else {
        const hit = await geocode(profile.home_address);
        if (hit) {
          homeOrigin = hit;
          await db
            .from("search_profiles")
            .update({ home_lat: hit.lat, home_lng: hit.lng })
            .eq("id", profileId);
          console.log(`[pipeline] stage 11b — home geocoded: ${profile.home_address} → ${hit.lat},${hit.lng}`);
        } else {
          console.warn(`[pipeline] stage 11b — could not geocode home_address "${profile.home_address}" — distance disabled this run`);
        }
      }
    }

    // Fallback origin: when the profile has no usable home address, use its SEARCH
    // location as the distance origin so distance still works from just the
    // Location field (the user-requested behaviour — distances appear without
    // requiring the separate optional address). Geocoded once; cached for the run.
    if (!homeOrigin && profile.location && profile.location.trim()) {
      const hit = await geocodeLocation(profile.location);
      if (hit) {
        homeOrigin = hit;
        console.log(`[pipeline] stage 11b — distance origin from search location: "${profile.location}"`);
      }
    }

    // When the bucket is on, distance is computed during serveProfileFromBucket
    // from each posting's STORED coords (geocoded once at write) — so skip this
    // per-run Nominatim geocoding loop entirely.
    if (homeOrigin && toSave.length > 0 && !bucketEnabled()) {
      await setStage(runLogId, `Computing distances (${toSave.length} jobs)`);
      let resolved = 0;
      let fallback = 0;
      const enriched: typeof toSave = [];
      for (const job of toSave) {
        const d = job.location ? await distanceFor(homeOrigin, job.location) : null;
        if (d) {
          resolved++;
          if (d.method === "haversine") fallback++;
          enriched.push({ ...job, distance_km: d.km, distance_method: d.method });
        } else {
          enriched.push(job);
        }
      }
      toSave = enriched;
      console.log(`[pipeline] stage 11b — distances: ${resolved}/${toSave.length} resolved (${fallback} haversine fallback)`);
    } else if (profile.home_address) {
      console.log(`[pipeline] stage 11b — distance skipped (no home origin or no jobs)`);
    }

    // ── Global bucket (USE_GLOBAL_BUCKET): grow bucket + serve full window ────
    // 1. Upsert this run's scraped survivors into the canonical bucket.
    // 2. Serve the profile's FULL retention window FROM the bucket (the scraped
    //    delta + everything other users already populated), tier-projected and
    //    re-filtered, then save THAT into `jobs`. So a near-empty delta scrape
    //    still yields the complete result set. No-op (toSave unchanged) when the
    //    flag is off, migrations aren't applied, or the bucket is empty.
    if (bucketEnabled() && bucketSlices.length > 0) {
      await upsertGlobalJobs(toSave, {
        adzunaFull: profile.adzuna_method === "direct",
        searchLocation: profile.location,
      });
      const served = await serveProfileFromBucket(profile, bucketSlices, {
        tier,
        homeOrigin,
        serveWindowDays: BUCKET_RETENTION_DAYS,
      });
      // Safety: only replace the scraped set if the bucket actually returned
      // rows (or we had nothing scraped anyway). Never blank out a non-empty
      // scrape because serve came back empty (e.g. a location-cell mismatch).
      if (served !== null && (served.length > 0 || toSave.length === 0)) {
        console.log(`[pipeline] bucket serve — replacing ${toSave.length} scraped with ${served.length} from bucket`);
        toSave = served;
      } else if (served !== null) {
        console.warn(`[pipeline] bucket serve returned 0 but ${toSave.length} scraped — keeping scraped set (safety)`);
      }
    }

    // Stage 12: save with visa info included
    await setStage(runLogId, `Saving ${toSave.length} jobs`);
    const { saved, bySource, savedIds } = await saveJobs(toSave, profileId);
    jobsSaved = saved;
    sourcesSaved = bySource;
    console.log(`[pipeline] stage 12 — saved: ${saved}`);

    // Stage 13 (Phase E-1): auto-analyze new jobs for automation_enabled
    // profiles. Best-effort and fire-and-forget — cv-backend returns 202
    // immediately and runs the AI pipeline in background. Failures here
    // DON'T mark the scrape run failed; they're logged and skipped.
    if (profile.automation_enabled && savedIds.length > 0) {
      await setStage(runLogId, `Auto-analyzing ${savedIds.length} jobs`);
      console.log(`[pipeline] stage 13 — auto-analyze ${savedIds.length} jobs (automation_enabled=true)`);
      try {
        // Geocode the search-profile location once (cached — already warmed by
        // the bucket serve). Passed to auto-analyze so a deliberate inter-city
        // search (home far from the searched city) still auto-analyzes jobs that
        // are near the SEARCH location, not just near home.
        const searchOrigin = profile.location
          ? await geocodeLocation(profile.location)
          : null;
        const result = await autoAnalyzeBatch(savedIds, {
          user_id:          profile.user_id,
          // Per-vertical ATS cutoffs (healthcare/nursing = 55/65). Resolved
          // inside triggerAutoAnalyze and passed in the analyze payload.
          target_verticals: profile.target_verticals,
          searchOrigin,
        });
        console.log(`[pipeline] stage 13 — triggered ${result.triggered}, skipped ${result.skipped}`);
      } catch (err) {
        console.error("[pipeline] stage 13 — autoAnalyzeBatch unexpected error:", err);
      }
    } else if (!profile.automation_enabled) {
      console.log(`[pipeline] stage 13 — skipped (automation_enabled=false)`);
    }

    // Update visa_likelihood float on saved jobs (for sort compatibility)
    // Derived: sponsored=1.0, not_mentioned=0.5, no/citizen_pr_only=0.0
    if (toSave.length > 0) {
      const visaUpdates = toSave.map((j) => ({
        url_hash: j.url_hash,
        visa_likelihood:
          j.sponsorship_status === "yes" ? 1.0
          : j.sponsorship_status === "no" || j.citizen_pr_only === true ? 0.0
          : 0.5,
      }));
      for (let i = 0; i < visaUpdates.length; i += 100) {
        const batch = visaUpdates.slice(i, i + 100);
        await Promise.all(
          batch.map((u) =>
            db.from("jobs")
              .update({ visa_likelihood: u.visa_likelihood })
              .eq("profile_id", profileId)
              .eq("url_hash", u.url_hash)
          )
        );
      }
    }

    await finishRunLog(runLogId, {
      status: "completed",
      jobs_fetched: jobsFetched,
      jobs_after_dedup: jobsAfterDedup,
      jobs_saved: jobsSaved,
      jobs_deduped: jobsDeduped,
      sources_run: sourcesRun,
      sources_saved: sourcesSaved,
      source_methods: sourceMethods,
    });

    // Phase A — record search-coverage (write-only). Warms the freshness ledger
    // so Phase B can drive the scrape delta + bucket serve. Best-effort: a
    // not-yet-applied migration 066 no-ops with a warning, never affects the run.
    const coverageSlices = resolveSlices(profile.keywords, profile.location, Array.from(coverageSources));
    await recordCoverage(coverageSlices, lookbackDays, jobsFetched);
    // Release single-flight locks so the next caller isn't blocked. (recordCoverage
    // upserts the row but leaves `refreshing` as-is, so we must clear it here.)
    if (bucketLockedSlices.length > 0) await releaseSliceLocks(bucketLockedSlices);

    console.log(`[pipeline] ─── run complete ───\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[pipeline] fatal error:", msg);
    
    // Only update to failed if it wasn't a manual cancellation 
    // (since manual cancellation already sets it to failed)
    if (msg !== "Cancelled by user") {
      await finishRunLog(runLogId, {
        status: "failed",
        jobs_fetched: jobsFetched,
        jobs_after_dedup: jobsAfterDedup,
        jobs_saved: jobsSaved,
        jobs_deduped: jobsDeduped,
        sources_run: sourcesRun,
        sources_saved: sourcesSaved,
        source_methods: sourceMethods,
        error_message: msg,
      });
      await sendPipelineFailureAlert(profileId, msg);
    } else {
      console.log(`[pipeline] Run gracefully stopped due to user cancellation.`);
    }
  }
}
