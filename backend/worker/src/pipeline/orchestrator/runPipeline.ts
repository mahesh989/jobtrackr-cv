import { db } from "../../db/client.js";
import { normalise } from "../normalise.js";
import { applyKeywordFilter } from "../keywordFilter.js";
import { dedup } from "../dedup.js";
import { saveJobs } from "../save.js";
import { resolveSlices, recordCoverage, releaseSliceLocks } from "../coverage.js";
import { bucketEnabled, upsertGlobalJobs, serveProfileFromBucket } from "../bucket.js";
import { postFetchFilter, formatExcludeBreakdown } from "../postFetchFilter.js";
import { startRunLog, finishRunLog, setStage } from "../runLog.js";
import { runLogContext } from "../logContext.js";
import { computeEligibility, isUserVisaStatus } from "../eligibility.js";
import { applySettingFilter, formatSettingBreakdown } from "../settingFilter.js";
import { sendPipelineFailureAlert } from "../../notifications/errorAlert.js";
import { autoAnalyzeBatch } from "../../automation/triggerAutoAnalyze.js";
import { geocode, geocodeLocation, distanceFor, type LatLng } from "../../lib/distance.js";
import { applyGate } from "../../notifications/gate.js";
import { loadProfile, normalizeWorkTypes } from "./profile.js";
import { loadPlatformSources } from "./platformSources.js";
import { expireStaleAndCheckActiveRun } from "./concurrency.js";
import { computeLookbackWindow } from "./lookback.js";
import { planBucketCoverage } from "./bucketCoverage.js";
import { loadApifyCredential } from "./apifyIntegration.js";
import { fetchFromSources } from "./sourceFetch.js";
import { earlyDedup } from "./earlyDedup.js";
import { enrichDescriptions } from "./enrichment.js";
import { extractJobFacts } from "./jobFacts.js";
import type { SourceMethods } from "./types.js";

export async function runPipeline(profileId: string, trigger: "manual" | "auto" = "auto", fullRefresh = false): Promise<void> {
  console.log(`\n[pipeline] ─── starting run for profile ${profileId} (trigger=${trigger}${fullRefresh ? ", full refresh" : ""}) ───`);

  // Stage 0: load profile
  const profile = await loadProfile(profileId);
  if (!profile) {
    console.error(`[pipeline] profile ${profileId} not found — aborting`);
    return;
  }

  // "Saved Jobs" (is_manual) holds manually-added jobs and has empty
  // keywords/location by design — fetching for it means a catch-all search
  // ("jobs" across the whole country) that burns a full run to save nothing.
  // The UI hides Run and the API rejects it; this is the last line, so no
  // enqueue path (stale job, direct call, manual insert) can get through.
  if (profile.is_manual) {
    console.warn(`[pipeline] profile ${profileId} is a manual "Saved Jobs" container — refusing to fetch`);
    return;
  }

  // User-level visa status + work types (My CV → user_preferences
  // .contact_details.visa_status / .credentials.availability — same
  // identity-level home as role_families, one control for all profiles).
  // Drives the stage-10b eligibility filter and the stage-10b++ work-type
  // filter — single source of truth; absent → no filtering. Replaces the
  // old per-profile search_profiles.employment_filter (migration 080 column
  // stays in the DB, unread — additive-only schema policy).
  try {
    const { data: prefRow } = await db
      .from("user_preferences")
      .select("contact_details")
      .eq("user_id", profile.user_id)
      .maybeSingle();
    const contactDetails = prefRow?.contact_details as
      { visa_status?: string; credentials?: { availability?: unknown } } | null;
    const vs = contactDetails?.visa_status;
    if (isUserVisaStatus(vs)) profile.user_visa_status = vs;
    profile.user_work_types = normalizeWorkTypes(contactDetails?.credentials?.availability);
  } catch {
    /* no prefs row / pre-migration — legacy behaviour */
  }

  // Activity-gated auto-fetch scheduling — scheduled (auto) runs only.
  // Manual runs (trigger="manual", user-initiated from the profile UI) are
  // NEVER gated: this must run before ANY tier-config/source/AI work so an
  // inactive/paused user's run is skipped before any Apify/LLM cost.
  if (trigger === "auto") {
    const gate = await applyGate(profileId, profile.user_id);
    if (!gate.proceed) {
      console.log(`[pipeline] profile ${profileId} — gated (paused), skipping run before any cost`);
      return;
    }
  }

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

  if (!(await expireStaleAndCheckActiveRun(profileId))) return;

  const lookbackPlan = await computeLookbackWindow(profileId, fullRefresh);
  const deepRun = lookbackPlan.deepRun;
  let lookbackDays = lookbackPlan.lookbackDays;

  const bucketPlan = await planBucketCoverage(profile, lookbackDays, fullRefresh);
  const bucketSlices       = bucketPlan.slices;
  const bucketSkipScrape   = bucketPlan.skipScrape;
  const bucketLockedSlices = bucketPlan.lockedSlices;
  lookbackDays = bucketPlan.lookbackDays;

  // Adzuna reads adzuna_max_days_old; SEEK + Careerjet read lookback_days /
  // is_first_run. Set all three so every date-aware adapter follows suit.
  // A full refresh also runs sources at first-run depth (more pages).
  profile.adzuna_max_days_old = lookbackDays;
  profile.lookback_days       = lookbackDays;
  profile.is_first_run        = deepRun;

  const apifyCreds = await loadApifyCredential(profile.user_id);
  const seekIntegration = apifyCreds.integration;
  const seekAdapter     = apifyCreds.adapter;
  const seekToken       = apifyCreds.token;

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
  let jobsFetched = 0;
  let jobsAfterDedup = 0;
  let jobsSaved = 0;
  let jobsDeduped = 0;
  let sourcesSaved: Record<string, number> = {};

  // Per-run source method tracking — persisted to run_logs.source_methods so
  // admins can diagnose paid-tier source failures without grepping log_lines.
  const sourceMethods: SourceMethods = { tier };

  try {
    // Per-profile source selection (Migration 041): null/empty = all sources.
    const enabledSources = profile.enabled_sources ?? null;
    const sourceEnabled = (name: string): boolean =>
      !enabledSources || enabledSources.length === 0 || enabledSources.includes(name);

    const rawJobs = await fetchFromSources(
      profile, runLogId, tier,
      { skipScrape: bucketSkipScrape },
      { adapter: seekAdapter, integration: seekIntegration },
      sourceEnabled,
      { sourcesRun, coverageSources, sourceMethods },
    );

    jobsFetched = rawJobs.length;
    console.log(`[pipeline] stage 2 done — total raw: ${jobsFetched}`);
    await setStage(runLogId, "Filtering & deduplicating");

    // Stages 3 + 3b: early URL dedup (this profile, then sibling profiles).
    const { jobs: newRawJobs, dropped: earlyDropped } =
      await earlyDedup(rawJobs, profileId, profile.user_id);
    jobsDeduped += earlyDropped;

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

    const enrichResult = await enrichDescriptions(
      dedupKept, profile, runLogId,
      { token: seekToken, integration: seekIntegration },
      sourceEnabled, sourceMethods,
    );
    const kept = enrichResult.jobs;
    if (enrichResult.descDropped > 0) jobsAfterDedup = kept.length;

    // Stages 10a + 10c + 10e - shared per-job facts.
    const settingReady = await extractJobFacts(kept, runLogId);

    // Working rights: single source of truth is My CV's visa_status via the
    // eligibility matrix below. The old per-profile working_rights filter was
    // removed — it contradicted the matrix (e.g. a citizen with a stale
    // "needs sponsorship" profile lost citizens/PR-only jobs), and for
    // needs_sponsorship users the matrix drops a strict superset anyway.
    let toSave = settingReady;

    // Stages 10b+/10b++/10d: eligibility matrix, work-type filter, work-setting
    // filter. LEGACY (non-bucket) path only by default — bucket mode replays
    // all three inside serveProfileFromBucket AFTER the shared bucket write
    // (upsertGlobalJobs below), so filtering `toSave` before that write would
    // drop jobs from the shared global_jobs bucket that OTHER profiles want
    // (bucket poisoning). Extracted to a closure (finding B5-P2 / chunk C15)
    // so the SAME filters can also be applied as a fallback further down when
    // bucket mode's own serve is skipped or its result can't be trusted — the
    // raw scrape must never reach saveJobs unfiltered on ANY path.
    const userVisa = profile.user_visa_status;
    const applyOwnershipFilters = (jobs: typeof toSave): typeof toSave => {
      let filtered = jobs;

      if (isUserVisaStatus(userVisa)) {
        const before = filtered.length;
        filtered = filtered.filter((j) => computeEligibility(j, userVisa) !== "not_eligible");
        if (before !== filtered.length) {
          console.log(`[pipeline] eligibility (${userVisa}): ${before - filtered.length} dropped, ${filtered.length} remaining`);
        }
      }

      if ((profile.user_work_types?.length ?? 0) > 0) {
        const keep = new Set(profile.user_work_types);
        const before = filtered.length;
        filtered = filtered.filter((j) => {
          const types = j.employment_types ?? [];
          return types.length === 0 || types.some((t) => keep.has(t));
        });
        if (before !== filtered.length) {
          console.log(`[pipeline] work-type filter [${profile.user_work_types!.join(",")}]: ${before - filtered.length} dropped, ${filtered.length} remaining`);
        }
      }

      if ((profile.setting_filter?.length ?? 0) > 0) {
        const { kept: afterSetting, dropped, byCategory } = applySettingFilter(filtered, profile);
        filtered = afterSetting;
        console.log(`[pipeline] setting filter: ${dropped} dropped, ${filtered.length} remaining${formatSettingBreakdown(byCategory)}`);
      }

      return filtered;
    };

    if (!bucketEnabled()) {
      toSave = applyOwnershipFilters(toSave);
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
      const upsertOk = await upsertGlobalJobs(toSave, {
        adzunaFull: profile.adzuna_method === "direct",
        searchLocation: profile.location,
      });
      const served = await serveProfileFromBucket(profile, bucketSlices, {
        tier,
        homeOrigin,
      });
      // Trust a successful bucket serve even when it legitimately returns
      // zero — that's serveProfileFromBucket's geo-radius + filter replay
      // working correctly (e.g. a niche search location with nothing nearby),
      // not a failure to guard against. Only fall back to the raw, UNFILTERED
      // scraped set when the serve call itself failed/was skipped
      // (served === null), or when this run's own upsert didn't make it into
      // the bucket (upsertOk === false) — in that case an empty `served`
      // would be a MASKED upsert failure rather than a genuine "nothing
      // nearby" result, and trusting it would wipe a good scrape to zero.
      if (served !== null && upsertOk) {
        if (served.length !== toSave.length) {
          console.log(`[pipeline] bucket serve — replacing ${toSave.length} scraped with ${served.length} from bucket`);
        }
        toSave = served;
      } else {
        // Finding B5-P2 (chunk C15) — the raw scrape was previously saved
        // as-is here, having never passed through ANY of the three filters
        // above (all gated on !bucketEnabled()). A student-visa user could
        // get jobs the eligibility matrix would hard-drop, and auto-analyze
        // would then spend AI credits tailoring CVs for them. This is the
        // one place bucket mode's own filter replay (serveProfileFromBucket)
        // didn't run, so apply the same legacy filters directly before this
        // set reaches saveJobs.
        const why = served === null ? "serve unavailable" : "upsert failed, serve result untrusted";
        const before = toSave.length;
        toSave = applyOwnershipFilters(toSave);
        console.warn(`[pipeline] bucket ${why} — applying legacy filters directly to the ${before} scraped jobs (${toSave.length} remaining)`);
      }
    }

    // Stage 12: save with visa info included
    await setStage(runLogId, `Saving ${toSave.length} jobs`);
    const { saved, newSaved, errors: saveErrors, bySource, savedIds } = await saveJobs(toSave, profileId);
    jobsSaved = saved;
    sourcesSaved = bySource;
    console.log(`[pipeline] stage 12 — saved: ${saved} (${newSaved} new)`);

    // Finding #54 — saveJobs can silently drop every write batch (Supabase
    // outage, schema drift, etc.) and the caller used to throw the error
    // count away entirely: the run finished status "completed" with no
    // alert, indistinguishable from "no new jobs this run". Surface it: an
    // alert always fires so a partial loss doesn't go unnoticed, and if
    // literally nothing saved despite jobs being found, the run is marked
    // "failed" (same as any other fatal error) rather than reporting a
    // false success.
    let saveErrorMessage: string | undefined;
    if (saveErrors > 0) {
      saveErrorMessage = `${saveErrors} of ${toSave.length} job(s) failed to save`;
      console.error(`[pipeline] stage 12 — ${saveErrorMessage}`);
      await sendPipelineFailureAlert(profileId, saveErrorMessage);
    }
    const totalSaveFailure = toSave.length > 0 && saveErrors === toSave.length;

    // Auto-run new-jobs notification queue — never for manual runs. A failure
    // here must NEVER fail the pipeline; it's purely a notification side effect.
    // Uses newSaved (rows that didn't already exist for this profile), NOT
    // the total `saved` count — otherwise every re-scrape of still-live
    // postings from prior runs gets reported to the user as "new" again.
    if (trigger === "auto" && newSaved > 0) {
      try {
        await db.from("pending_job_notifications").insert({
          user_id: profile.user_id,
          profile_id: profileId,
          profile_name: profile.name ?? "",
          jobs_saved: newSaved,
        });
      } catch (err) {
        console.error("[pipeline] failed to queue new-jobs notification (non-fatal):", err);
      }
    }

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
      status: totalSaveFailure ? "failed" : "completed",
      jobs_fetched: jobsFetched,
      jobs_after_dedup: jobsAfterDedup,
      jobs_saved: jobsSaved,
      jobs_deduped: jobsDeduped,
      sources_run: sourcesRun,
      sources_saved: sourcesSaved,
      source_methods: sourceMethods,
      ...(saveErrorMessage ? { error_message: saveErrorMessage } : {}),
    });

    // Phase A — record search-coverage (write-only). Warms the freshness ledger
    // so Phase B can drive the scrape delta + bucket serve. Best-effort: a
    // not-yet-applied migration 066 no-ops with a warning, never affects the run.
    const coverageSlices = resolveSlices(profile.keywords, profile.location, Array.from(coverageSources));
    await recordCoverage(coverageSlices, lookbackDays, jobsFetched);

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
  } finally {
    // Single-flight locks must be released whether this run succeeded or
    // threw — previously this only happened on the success path, so any
    // exception between acquiring a lock and here left it held until the
    // 10-minute staleness timeout, silently forcing every profile sharing
    // that slice onto bucket-only serving for up to 10 minutes (#35 audit).
    if (bucketLockedSlices.length > 0) await releaseSliceLocks(bucketLockedSlices);
  }
}
