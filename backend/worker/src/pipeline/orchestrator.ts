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
import { postFetchFilter, excludeByDescription, formatExcludeBreakdown } from "./postFetchFilter.js";
import { startRunLog, finishRunLog, setStage } from "./runLog.js";
import { runLogContext } from "./logContext.js";
import { extractVisaInfo } from "../ai/visaExtractor.js";
import { isBlocked, recordSuccess, recordFailure } from "./healthTracker.js";
import { sendPipelineFailureAlert } from "../notifications/errorAlert.js";
import { createSeekAdapter, enrichWithFullJDs } from "../sources/seek.js";
import { seekDirectAdapter, enrichWithDirectJDs } from "../sources/seekDirect.js";
import { careerjetAdapter, enrichWithCareerjetJDs } from "../sources/careerjet.js";
import { createCareerjetActorAdapter } from "../sources/careerjetActor.js";
import { enrichWithAdzunaJDs } from "../sources/adzuna.js";
import { decryptApiKey } from "../lib/crypto.js";
import { autoAnalyzeBatch } from "../automation/triggerAutoAnalyze.js";
import { geocode, distanceFor, type LatLng } from "../lib/distance.js";

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

/** Load the user's Apify integration row. Returns null if not connected. */
async function loadApifyIntegration(userId: string): Promise<UserIntegration | null> {
  const { data } = await db
    .from("user_integrations")
    .select("id, encrypted_api_key, status, quota_used_usd, quota_used_requests, quota_period_start, is_enabled, config")
    .eq("user_id", userId)
    .eq("provider", "apify")
    .maybeSingle();
  return data as UserIntegration | null;
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
    .select("id, user_id, keywords, location, visa_filter_mode, working_rights, target_verticals, adzuna_title_keywords, adzuna_exact_phrase, adzuna_any_keywords, adzuna_exclude_keywords, adzuna_salary_min, adzuna_salary_max, adzuna_contract_type, adzuna_hours, adzuna_distance_km, adzuna_max_days_old, exclude_title_keywords, must_include_phrases, automation_enabled, enabled_sources, seek_method, adzuna_method, home_address, home_lat, home_lng")
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


export async function runPipeline(profileId: string, trigger: "manual" | "auto" = "auto"): Promise<void> {
  console.log(`\n[pipeline] ─── starting run for profile ${profileId} (trigger=${trigger}) ───`);

  // Stage 0: load profile
  const profile = await loadProfile(profileId);
  if (!profile) {
    console.error(`[pipeline] profile ${profileId} not found — aborting`);
    return;
  }

  profile.is_manual_run = trigger === "manual";

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
  let lookbackDays: number;
  if (lastRun) {
    // Incremental: fetch only what's new since last success + 1 day buffer
    const daysSince = Math.ceil(
      (Date.now() - new Date(lastRun.started_at).getTime()) / 86_400_000
    );
    lookbackDays = Math.min(daysSince + 1, 30);
    console.log(`[pipeline] lookback: ${lookbackDays}d (incremental — last run ${daysSince}d ago)`);
  } else {
    // First run: deep cold-start backfill
    lookbackDays = FIRST_RUN_LOOKBACK_DAYS;
    console.log(`[pipeline] lookback: ${lookbackDays}d (first run — deep cold-start backfill)`);
  }
  // Adzuna reads adzuna_max_days_old; SEEK + Careerjet read lookback_days /
  // is_first_run. Set all three so every date-aware adapter follows suit.
  profile.adzuna_max_days_old = lookbackDays;
  profile.lookback_days       = lookbackDays;
  profile.is_first_run        = isFirstRun;

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
  let jobsFetched = 0;
  let jobsAfterDedup = 0;
  let jobsSaved = 0;
  let jobsDeduped = 0;
  let sourcesSaved: Record<string, number> = {};

  try {
    // Per-profile source selection (Migration 041): null/empty = all sources.
    const enabledSources = profile.enabled_sources ?? null;
    const sourceEnabled = (name: string): boolean =>
      !enabledSources || enabledSources.length === 0 || enabledSources.includes(name);

    // Stage 2: source layer
    const rawJobs: RawJob[] = [];
    for (const adapter of adapters) {
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
    // chosen per profile via seek_method (Migration 041). 'direct' still falls
    // back to the actor if it throws. SEEK runs only if it's an enabled source.
    const seekEnabled = sourceEnabled("seek");
    const useActor = profile.seek_method === "actor";
    let seekDirectFailed = false;
    if (!seekEnabled) {
      console.log(`[pipeline] stage 2 — seek: skipped (not in enabled_sources)`);
    } else {
      await checkCancellation(runLogId);
      await setStage(runLogId, "Fetching from SEEK");
      if (useActor) {
        seekDirectFailed = true; // route straight to the actor block below
        if (seekAdapter && seekIntegration) {
          console.log(`[pipeline] seek: method=actor — using Apify actor`);
        } else {
          console.warn(`[pipeline] seek: method=actor but no working Apify integration — SEEK will be skipped`);
        }
      } else {
        try {
          const seekJobs = await seekDirectAdapter.fetchJobs(profile);
          rawJobs.push(...seekJobs);
          sourcesRun.push("seek");
          console.log(`[pipeline]   seek (direct): ${seekJobs.length} raw (cost $0)`);
        } catch (err) {
          seekDirectFailed = true;
          console.warn(`[pipeline] seek-direct failed: ${err instanceof Error ? err.message : err}`);
          if (seekAdapter && seekIntegration) {
            console.warn(`[pipeline] seek-direct unavailable — falling back to Apify actor`);
          } else {
            console.warn(`[pipeline] seek-direct unavailable and no Apify fallback configured — skipping SEEK`);
          }
        }
      }
    }

    // Actor: runs when method=actor or direct threw, and the user has a working
    // Apify integration.
    if (seekEnabled && seekDirectFailed && seekAdapter && seekIntegration) {
      await checkCancellation(runLogId);
      await setStage(runLogId, useActor ? "Fetching from SEEK (Apify)" : "Fetching from SEEK (Apify fallback)");
      try {
        const { jobs: seekJobs, costUsd } = await seekAdapter.fetchJobs(profile);
        rawJobs.push(...seekJobs);
        if (!sourcesRun.includes("seek")) sourcesRun.push("seek");
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
        console.error(`[pipeline] seek (apify fallback) failed: ${err instanceof Error ? err.message : err}`);
        // Mark as invalid so next run doesn't retry a broken token
        await db.from("user_integrations")
          .update({ status: "invalid", status_reason: err instanceof Error ? err.message : String(err), updated_at: new Date().toISOString() })
          .eq("id", seekIntegration.id);
      }
    }

    // ── Careerjet ──────────────────────────────────────────────────────────────
    // Custom Apify actor (careerjet-au-scraper) over a residential AU proxy when
    // the user's Apify token is present → full JDs. Otherwise the free v4 API
    // adapter (listings + ~251-char snippet). careerjet.com.au Turnstile-blocks
    // datacenter IPs, so there is no direct-scrape path from Fly. Handled here
    // (not in adapters[]) so it can use the per-user Apify token like SEEK.
    let careerjetViaActor = false;
    const careerjetEnabled = sourceEnabled("careerjet");
    if (!careerjetEnabled) {
      console.log(`[pipeline] stage 2 — careerjet: skipped (not in enabled_sources)`);
    } else if (seekToken && seekIntegration) {
      // seekToken is set only when the Apify integration is valid AND within
      // budget — so this also gates careerjet on the shared Apify budget.
      await checkCancellation(runLogId);
      await setStage(runLogId, "Fetching from Careerjet (Apify)");
      try {
        const adapter = createCareerjetActorAdapter(seekToken);
        const { jobs, costUsd } = await adapter.fetchJobs(profile);
        rawJobs.push(...jobs);
        if (!sourcesRun.includes("careerjet")) sourcesRun.push("careerjet");
        careerjetViaActor = true;
        console.log(`[pipeline]   careerjet (apify actor): ${jobs.length} raw (cost $${costUsd.toFixed(4)})`);
        // Persist spend on the shared Apify integration. Re-read first so we
        // don't clobber the SEEK block's earlier increment in the same run.
        try {
          const { data: fresh } = await db.from("user_integrations")
            .select("quota_used_usd, quota_used_requests").eq("id", seekIntegration.id).single();
          const baseSpend = fresh?.quota_used_usd ?? seekIntegration.quota_used_usd;
          const baseReqs  = fresh?.quota_used_requests ?? seekIntegration.quota_used_requests;
          const newSpend  = baseSpend + costUsd;
          await db.from("user_integrations").update({
            quota_used_usd:      newSpend,
            quota_used_requests: baseReqs + jobs.length,
            last_used_at:        new Date().toISOString(),
            status:              newSpend >= SEEK_MONTHLY_BUDGET_USD ? "quota_exceeded" : "valid",
            status_reason:       newSpend >= SEEK_MONTHLY_BUDGET_USD ? `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached` : null,
            updated_at:          new Date().toISOString(),
          }).eq("id", seekIntegration.id);
        } catch (e) {
          console.warn(`[pipeline] careerjet spend update failed (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
      } catch (err) {
        console.warn(`[pipeline] careerjet actor failed — falling back to v4 API: ${err instanceof Error ? err.message : err}`);
        try {
          const jobs = await careerjetAdapter.fetchJobs(profile);
          rawJobs.push(...jobs);
          if (!sourcesRun.includes("careerjet")) sourcesRun.push("careerjet");
          console.log(`[pipeline]   careerjet (v4 api fallback): ${jobs.length} raw`);
        } catch (err2) {
          console.error(`[pipeline] careerjet API fallback failed: ${err2 instanceof Error ? err2.message : err2}`);
        }
      }
    } else {
      // No Apify token → free v4 API (snippet JDs).
      await checkCancellation(runLogId);
      await setStage(runLogId, "Fetching from Careerjet");
      try {
        const jobs = await careerjetAdapter.fetchJobs(profile);
        rawJobs.push(...jobs);
        if (!sourcesRun.includes("careerjet")) sourcesRun.push("careerjet");
        console.log(`[pipeline]   careerjet (v4 api): ${jobs.length} raw`);
      } catch (err) {
        console.error(`[pipeline] careerjet API failed: ${err instanceof Error ? err.message : err}`);
      }
    }

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

    // ── Stage 7: SEEK JD enrichment ────────────────────────────────────────────
    // Fetch full job descriptions for SEEK survivors only — i.e. jobs that have
    // already passed keyword + smart + dedup filters. Every JD we pay for goes
    // on to be saved (modulo the desc-exclusion re-check below). Non-SEEK
    // sources pass through unchanged.
    let kept = dedupKept;
    const seekSurvivors = dedupKept.some((j) => j.source === "seek");
    if (seekSurvivors) {
      await setStage(runLogId, "Fetching full SEEK descriptions");

      // Primary: direct fetch via got-scraping (free, fast).
      let directMerged = 0;
      let directFetched = 0;
      let directThrew = false;
      const jdCap = 20;
      try {
        const { jobs: enriched, merged, fetched } = await enrichWithDirectJDs(dedupKept, jdCap);
        kept = enriched;
        directMerged = merged;
        directFetched = fetched;
        console.log(`[pipeline] stage 7 — SEEK JD direct: ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
      } catch (err) {
        directThrew = true;
        console.warn(`[pipeline] stage 7 — SEEK JD direct threw: ${err instanceof Error ? err.message : err}`);
      }

      // Fallback: Apify enrichment only if direct couldn't merge ANY descriptions
      // AND the user has a working Apify integration with budget left.
      const directProducedNothing = directThrew || (directFetched > 0 && directMerged === 0);
      if (directProducedNothing && seekAdapter && seekToken && seekIntegration) {
        console.warn(`[pipeline] stage 7 — falling back to Apify JD fetcher`);
        const { jobs: enriched, costUsd: jdCost, merged, fetched } =
          await enrichWithFullJDs(kept, seekToken);
        kept = enriched;
        console.log(`[pipeline] stage 7 — SEEK JD apify fallback: ${merged}/${fetched} full descriptions merged (cost $${jdCost.toFixed(4)})`);

        if (jdCost > 0) {
          const newSpend  = seekIntegration.quota_used_usd + jdCost;
          const newStatus = newSpend >= SEEK_MONTHLY_BUDGET_USD ? "quota_exceeded" : "valid";
          await db.from("user_integrations")
            .update({
              quota_used_usd: newSpend,
              last_used_at:   new Date().toISOString(),
              status:         newStatus,
              status_reason:  newStatus === "quota_exceeded"
                ? `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached`
                : null,
              updated_at:     new Date().toISOString(),
            })
            .eq("id", seekIntegration.id);
          // Keep local copy fresh so any later updates stack correctly
          seekIntegration.quota_used_usd = newSpend;
        }
      }
    }

    // ── Stage 7c: Careerjet full-JD enrichment ─────────────────────────────────
    // Mirrors SEEK's pattern — Careerjet survivors only, free (got-scraping +
    // Apify residential proxy on Fly). Runs independently of SEEK so a
    // Careerjet-only profile still gets full JDs.
    const careerjetSurvivors = kept.some((j) => j.source === "careerjet");
    if (careerjetSurvivors && careerjetViaActor) {
      console.log(`[pipeline] stage 7c — Careerjet JD: skipped (actor already returned full descriptions)`);
    } else if (careerjetSurvivors) {
      await setStage(runLogId, "Fetching full Careerjet descriptions");
      const jdCap = 20;
      try {
        const { jobs: enriched, merged, fetched } = await enrichWithCareerjetJDs(kept, jdCap);
        kept = enriched;
        console.log(`[pipeline] stage 7c — Careerjet JD: ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
      } catch (err) {
        console.warn(`[pipeline] stage 7c — Careerjet JD threw: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── Stage 7d: Adzuna full-JD enrichment (opt-in via adzuna_method) ─────────
    // 'api' (default) → skip entirely; teasers carry forward (~600 char each).
    // 'direct'        → scrape /details/<id> HTML for full JD, cap 50.
    //                   Adds ~2.5–5 min to the run (BullMQ background, UI unaffected).
    const adzunaSurvivors = kept.some((j) => j.source === "adzuna");
    const useAdzunaDirect = profile.adzuna_method === "direct";
    if (adzunaSurvivors && useAdzunaDirect) {
      await setStage(runLogId, "Fetching full Adzuna descriptions");
      const jdCap = 50;
      try {
        const { jobs: enriched, merged, fetched } = await enrichWithAdzunaJDs(kept, jdCap);
        kept = enriched;
        console.log(`[pipeline] stage 7d — Adzuna JD (direct): ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
      } catch (err) {
        console.warn(`[pipeline] stage 7d — Adzuna JD threw: ${err instanceof Error ? err.message : err}`);
      }
    } else if (adzunaSurvivors) {
      console.log(`[pipeline] stage 7d — Adzuna JD: skipped (adzuna_method='${profile.adzuna_method ?? 'api'}', using API teasers only)`);
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

    // Stage 10b: working rights filter
    // Drop jobs that conflict with the user's working rights situation.
    // "needs_sponsorship" → drop jobs that explicitly say no sponsorship or citizens/PR only.
    // "pr_citizen" and "any" → no filtering, all jobs saved (just different labels shown).
    let toSave = visaReady;
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

    if (homeOrigin && toSave.length > 0) {
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
        const result = await autoAnalyzeBatch(savedIds, {
          user_id:          profile.user_id,
          // Per-vertical ATS cutoffs (healthcare/nursing = 55/65). Resolved
          // inside triggerAutoAnalyze and passed in the analyze payload.
          target_verticals: profile.target_verticals,
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
    });

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
        error_message: msg,
      });
      await sendPipelineFailureAlert(profileId, msg);
    } else {
      console.log(`[pipeline] Run gracefully stopped due to user cancellation.`);
    }
  }
}
