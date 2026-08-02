/**
 * Dashboard data layer — everything the dashboard route needs, minus rendering.
 *
 * Extracted from app/(dashboard)/dashboard/page.tsx so the fetching, threshold
 * resolution and derivation are testable without a Next.js request context.
 * This is a behaviour-preserving move: query shapes, filter order, comparison
 * operators and comment-documented invariants are carried over verbatim.
 *
 * WHAT STAYS IN THE ROUTE FILE (and why):
 *   - getAuthUser() + redirect("/auth/login")
 *   - the jt_user_view cookie read + redirect("/admin")
 *   - createClient() itself
 * redirect() throws NEXT_REDIRECT to unwind the route segment, and cookies() is
 * request-scoped; both belong to the request, not to data loading. The route
 * therefore resolves auth/redirects first and hands this module an already-built
 * Supabase client.
 *
 * Every exported helper below the orchestrator is pure — no I/O, no framework —
 * which is what makes getDashboardData.test.ts possible.
 */

import { MIN_INITIAL_ATS, MIN_FINAL_ATS, resolveThresholds } from "@/lib/atsThresholds";
import { jobNeedsJd, normalizeWorkTypes, passesWorkTypes, type BoardJob } from "@/features/jobs/lib/jobFilters";
import { indexLatestByJob, type AnalysisRunRef, type CoverLetterRef } from "@/features/jobs/lib/progressFlags";
import { recomputeGates } from "@/features/jobs/lib/pipelineState";
import { deriveBoardJob } from "@/features/jobs/lib/boardDerivation";
// Type-only: PipelineDonut is a "use client" module, so a value import would
// drag React into the (node-environment) unit tests.
import type { PipelineLensData } from "@/features/dashboard/PipelineDonut";
import type { FunnelCounts } from "@/features/jobs/components/PipelineFunnel";
import type { createClient } from "@/lib/supabase/server";

/** The request-scoped Supabase client, as built by lib/supabase/server. */
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export interface DashboardSearchParams {
  sort?:          string;
  dir?:           string;
  stage?:         string;
  triage?:        string;
  /** @deprecated — kept for backward compat */
  status?:        string;
  /** @deprecated — kept for backward compat */
  chips?:         string;
  min_keywords?:  string;
  min_visa?:      string;
  visa_toggle?:   string;
  source?:        string;
  location?:      string;
  posted_within?: string;
  /** ATS-score band filter: above_final | below_final | below_initial | no_ats */
  ats?:           string;
}

/** The profile columns this page reads (subset of CachedProfile). */
export interface DashboardProfile {
  id: string; name: string; is_active: boolean;
  keywords: string[]; location: string; schedule_cron: string;
  target_verticals?: string[] | null;
  adzuna_exclude_keywords?: string | null;
}

export interface AllCountRow {
  id: string; seen_at: string | null; applied_at: string | null;
  dismissed_at: string | null; starred_at: string | null; profile_id: string;
  jd_quality: string | null; manual_jd_text: string | null;
  role_match: string | null; has_email: boolean | null;
  employment_types?: string[] | null;
}
export interface DonutRunRow {
  job_id: string; initial_ats_score: number | null; tailored_match_score: number | null;
  passed_initial_gate: boolean | null; passed_final_gate: boolean | null;
  ats_lift: number | null; tailored_pdf_storage_path: string | null;
  tailored_cv_storage_path: string | null; created_at: string | null;
}
export interface DonutLetterRow { job_id: string }
export interface RunLogRow {
  profile_id: string;
  jobs_fetched: number | null;
  jobs_after_dedup: number | null;
  jobs_saved: number | null;
  jobs_deduped: number | null;
  sources_saved: Record<string, number> | null;
}
export type ActiveJobRow = {
  id: string; profile_id: string; created_at?: string | null; [k: string]: unknown;
};
export interface BoardThresholds { initial: number; final: number }

/** Everything the route renders. */
export interface DashboardViewData {
  typedJobs:             BoardJob[];
  funnelCounts:          FunnelCounts;
  lensData:              PipelineLensData;
  totalJobs:             number;
  totalNew:              number;
  totalApplied:          number;
  activeCount:           number;
  mergedExcludeKeywords: string;
  isNewView:             boolean;
}

export type DashboardResult =
  /** First-run gate: no jobs exist yet, render the "ready to scan" screen. */
  | { kind: "empty"; hasProfiles: boolean }
  | { kind: "ready"; data: DashboardViewData };

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * ATS thresholds are resolved per-vertical (e.g. 55/65 for healthcare/nursing).
 * The vertical is the user's ONE global My CV choice (contact_details.role_families)
 * — the same source the analysis pipeline uses — so the board bands match the
 * gate the analysis actually applied. Per-profile target_verticals is a legacy
 * fallback for users without a My CV selection.
 */
export function resolveProfileThresholds(
  profiles: DashboardProfile[],
  myCvVerticals: string[],
): Map<string, BoardThresholds> {
  return new Map<string, BoardThresholds>(
    profiles.map((p) => [
      p.id,
      resolveThresholds(myCvVerticals.length > 0 ? myCvVerticals : p.target_verticals),
    ]),
  );
}

/** role_families from the user_preferences row, empty-filtered. */
export function readMyCvVerticals(prefRow: { contact_details?: unknown } | null): string[] {
  return (
    (prefRow?.contact_details as { role_families?: string[] | null } | null)?.role_families ?? []
  ).filter(Boolean);
}

/**
 * Fold the acted-on rows into the capped page of active jobs, deduped by id —
 * the two queries overlap for anything recent enough to be in both. Must run
 * BEFORE the ?status=new narrowing so an old applied job can't leak into
 * "jobs from the latest fetch".
 */
export function mergeActionedJobs(
  jobs: ActiveJobRow[],
  actionedJobs: ActiveJobRow[],
): ActiveJobRow[] {
  const merged = [...jobs];
  const seen = new Set(merged.map((j) => j.id));
  for (const j of actionedJobs) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    merged.push(j);
  }
  return merged;
}

/**
 * ?status=new — latest fetched batch (cross-profile).
 * "New jobs" = per profile, jobs first discovered (created_at) since the start
 * of that profile's most recent completed run that actually found something.
 * Stable until the next batch — independent of seen_at (which is consumed on
 * first view). Profiles with no completed run yet keep all their jobs (the
 * first fetch IS the first batch).
 */
export function narrowToLatestFetch(
  activeJobs: ActiveJobRow[],
  completedRuns: Array<{ profile_id: string; started_at: string }>,
): ActiveJobRow[] {
  const runsByProfile = new Map<string, number[]>(); // newest-first (query desc)
  for (const r of completedRuns) {
    const t = new Date(r.started_at).getTime();
    if (isNaN(t)) continue;
    const list = runsByProfile.get(r.profile_id) ?? [];
    list.push(t);
    runsByProfile.set(r.profile_id, list);
  }
  const createdMs = (j: { created_at?: string | null }) => {
    const t = new Date(j.created_at ?? "").getTime();
    return isNaN(t) ? 0 : t;
  };
  const floorByProfile = new Map<string, number>();
  for (const [pid, starts] of runsByProfile) {
    const profJobs = activeJobs.filter((j) => j.profile_id === pid);
    const floor = starts.find((t) => profJobs.some((j) => createdMs(j) >= t));
    if (floor !== undefined) floorByProfile.set(pid, floor);
  }
  return activeJobs.filter((j) => {
    const floor = floorByProfile.get(j.profile_id);
    return floor === undefined || createdMs(j) >= floor;
  });
}

/**
 * Global (not filter-dependent) counts for the funnel chips. View filtering and
 * sorting happen client-side in <JobBoard> from the full loaded set, so these
 * stay correct without recomputation.
 */
export function computeFunnelCounts(input: {
  allRows:          AllCountRow[];
  runsData:         Array<{ job_id: string; tailored_cv_storage_path?: string | null; tailored_pdf_storage_path?: string | null; initial_ats_score?: number | null; tailored_match_score?: number | null }>;
  lettersData:      Array<{ job_id: string }>;
  threshByProfile:  Map<string, BoardThresholds>;
  totalNew:         number;
}): FunnelCounts {
  const { allRows, runsData, lettersData, threshByProfile, totalNew } = input;

  const analysedSet = new Set(runsData.map((r) => r.job_id));
  const cvReadySet = new Set(runsData.filter((r) => r.tailored_cv_storage_path || r.tailored_pdf_storage_path).map((r) => r.job_id));
  const letterReadySet = new Set(lettersData.map((l) => l.job_id));
  // "Below ATS" = failed either gate, recomputed LIVE from stored scores vs the
  // job's profile thresholds (not the frozen passed_*_gate booleans).
  const profileByJobId = new Map(allRows.map((j) => [j.id, j.profile_id]));
  const belowThresholdSet = new Set(
    runsData
      .filter((r) => {
        const th = threshByProfile.get(profileByJobId.get(r.job_id) ?? "") ?? { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };
        const g = recomputeGates(
          r.initial_ats_score,
          r.tailored_match_score,
          th.initial, th.final,
        );
        return g.passedInitial === false || g.passedFinal === false;
      })
      .map((r) => r.job_id)
  );

  const tabTotalCount   = allRows.filter((j) => !j.dismissed_at).length;
  // Exclude dismissed jobs from the applied count — dismissed+applied jobs are
  // not shown in the Applied stage view (server-side filters dismissed_at IS NULL)
  // so the chip count must match what's actually visible.
  const tabAppliedCount = allRows.filter((j) => j.applied_at && !j.dismissed_at).length;
  const tabDismissedCount = allRows.filter((j) => j.dismissed_at).length;

  return {
    discovered:     tabTotalCount,
    analysed:       allRows.filter((j) => !j.dismissed_at && analysedSet.has(j.id)).length,
    cvReady:        allRows.filter((j) => !j.dismissed_at && cvReadySet.has(j.id)).length,
    letterReady:    allRows.filter((j) => !j.dismissed_at && letterReadySet.has(j.id)).length,
    applied:        tabAppliedCount,
    dismissed:      tabDismissedCount,
    favourite:      allRows.filter((j) => j.starred_at && !j.dismissed_at).length,
    newCount:       totalNew,
    needsJd:        allRows.filter((j) => !j.dismissed_at && jobNeedsJd(j)).length,
    roleMismatch:   allRows.filter((j) => !j.dismissed_at && j.role_match === "mismatch").length,
    belowThreshold: allRows.filter((j) => !j.dismissed_at && belowThresholdSet.has(j.id)).length,
    hasEmail:       allRows.filter((j) => !j.dismissed_at && j.has_email === true).length,
    thinJd:         allRows.filter((j) => !j.dismissed_at && jobNeedsJd(j)).length,
    richJd:         allRows.filter((j) => !j.dismissed_at && (j.jd_quality === "rich" || (j.jd_quality === "thin" && !jobNeedsJd(j)))).length,
  };
}

/** Pipeline donut lens data — sourcing / JD / analysis / ATS / applied. */
export function computeLensData(input: {
  ids:              string[];
  profileNameById:  Map<string, string>;
  activeJobRows:    AllCountRow[];
  runLogData:       RunLogRow[];
  donutRunData:     DonutRunRow[];
  donutLetterData:  DonutLetterRow[];
  threshByProfile:  Map<string, BoardThresholds>;
  thinJdCount:      number;
}): PipelineLensData {
  const {
    ids, profileNameById, activeJobRows, runLogData, donutRunData,
    donutLetterData, threshByProfile, thinJdCount,
  } = input;

  // Sourcing: aggregate run_logs lifetime totals per profile
  const srcMap: Record<string, { saved: number; dupes: number; filtered: number; sourcesSaved: Record<string, number> }> = {};
  for (const r of runLogData) {
    const pid     = r.profile_id;
    if (!srcMap[pid]) srcMap[pid] = { saved: 0, dupes: 0, filtered: 0, sourcesSaved: {} };
    const s       = srcMap[pid];
    const fetched = r.jobs_fetched  ?? 0;
    const saved   = r.jobs_saved    ?? 0;
    const deduped = r.jobs_deduped  ?? null;
    s.saved += saved;
    if (deduped !== null) {
      // New runs: split accurately into deduped vs keyword/smart-filtered
      s.dupes    += deduped;
      s.filtered += Math.max(0, fetched - deduped - saved);
    } else {
      // Old runs (pre-migration): can't distinguish, lump into filtered
      s.filtered += Math.max(0, fetched - saved);
    }
    if (r.sources_saved) {
      for (const [src, n] of Object.entries(r.sources_saved)) {
        s.sourcesSaved[src] = (s.sourcesSaved[src] ?? 0) + n;
      }
    }
  }
  const srcVals          = Object.values(srcMap);
  const sourcingFetched  = runLogData.reduce<number>((a, r) => a + (r.jobs_fetched ?? 0), 0);
  const sourcingTotals: [number, number, number] = [
    srcVals.reduce((a, s) => a + s.saved,    0),
    srcVals.reduce((a, s) => a + s.dupes,    0),
    srcVals.reduce((a, s) => a + s.filtered, 0),
  ];
  const sourcingByProfile = ids
    .filter((id) => srcMap[id])
    .map((id) => ({
      profileId:    id,
      profileName:  profileNameById.get(id) ?? id,
      counts:       [srcMap[id].saved, srcMap[id].dupes, srcMap[id].filtered] as [number, number, number],
      sourcesSaved: srcMap[id].sourcesSaved,
    }));

  // JD readiness: from activeJobRows (already includes jd_quality)
  const jdMap: Record<string, [number, number, number]> = {};
  for (const j of activeJobRows) {
    const pid = j.profile_id;
    if (!jdMap[pid]) jdMap[pid] = [0, 0, 0];
    if (j.jd_quality === "rich") jdMap[pid][0]++;
    else if (j.jd_quality === "thin") jdMap[pid][1]++;
    else jdMap[pid][2]++;
  }
  const jdTotals: [number, number, number] = [0, 0, 0];
  for (const c of Object.values(jdMap)) { jdTotals[0] += c[0]; jdTotals[1] += c[1]; jdTotals[2] += c[2]; }
  const jdByProfile = ids
    .filter((id) => jdMap[id] && (jdMap[id][0] + jdMap[id][1] + jdMap[id][2]) > 0)
    .map((id) => ({ profileId: id, profileName: profileNameById.get(id) ?? id, counts: jdMap[id] }));

  // Analysis + ATS gates: from donut analysis_runs (all active jobs)
  const latestDonutRunByJob = new Map<string, DonutRunRow>();
  for (const r of donutRunData) {
    if (!latestDonutRunByJob.has(r.job_id)) latestDonutRunByJob.set(r.job_id, r);
  }
  const letterJobIds = new Set(donutLetterData.map((l) => l.job_id));

  const analysisMap: Record<string, [number, number, number]> = {};
  const atsMap:      Record<string, [number, number, number]> = {};
  const appliedMap:  Record<string, [number, number, number]> = {};
  for (const id of ids) { analysisMap[id] = [0, 0, 0]; atsMap[id] = [0, 0, 0]; appliedMap[id] = [0, 0, 0]; }

  let atsLiftSum = 0, atsLiftCount = 0, passedButNoLetterCount = 0;

  for (const j of activeJobRows) {
    const pid      = j.profile_id;
    const run      = latestDonutRunByJob.get(j.id);
    const hasLetter = letterJobIds.has(j.id);
    const hasCv    = !!(run?.tailored_pdf_storage_path || run?.tailored_cv_storage_path);

    // Analysis lens
    if (hasCv && hasLetter) analysisMap[pid][0]++;
    else if (hasCv)         analysisMap[pid][1]++;
    else                    analysisMap[pid][2]++;

    // ATS lens (only jobs with runs) — gates recomputed LIVE vs current thresholds
    if (run) {
      const th = threshByProfile.get(pid) ?? { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };
      const g = recomputeGates(run.initial_ats_score, run.tailored_match_score, th.initial, th.final);
      if (g.passedFinal)        atsMap[pid][0]++;
      else if (g.passedInitial) atsMap[pid][1]++;
      else                      atsMap[pid][2]++;
      if (run.ats_lift !== null) { atsLiftSum += run.ats_lift; atsLiftCount++; }
      if (g.passedFinal && !hasLetter && !j.applied_at) passedButNoLetterCount++;
    }

    // Applied lens
    if (j.applied_at)      appliedMap[pid][0]++;
    else if (hasLetter)    appliedMap[pid][1]++;
    else                   appliedMap[pid][2]++;
  }

  const analysisTotals: [number, number, number] = [0, 0, 0];
  for (const c of Object.values(analysisMap)) { analysisTotals[0] += c[0]; analysisTotals[1] += c[1]; analysisTotals[2] += c[2]; }
  const atsTotals: [number, number, number] = [0, 0, 0];
  for (const c of Object.values(atsMap)) { atsTotals[0] += c[0]; atsTotals[1] += c[1]; atsTotals[2] += c[2]; }
  const appliedTotals: [number, number, number] = [0, 0, 0];
  for (const c of Object.values(appliedMap)) { appliedTotals[0] += c[0]; appliedTotals[1] += c[1]; appliedTotals[2] += c[2]; }

  const avgAtsLift = atsLiftCount > 0 ? Math.round(atsLiftSum / atsLiftCount) : null;

  function mkProfiles(map: Record<string, [number, number, number]>) {
    return ids
      .filter((id) => map[id] && (map[id][0] + map[id][1] + map[id][2]) > 0)
      .map((id) => ({ profileId: id, profileName: profileNameById.get(id) ?? id, counts: map[id] }));
  }

  // Global thresholds since migration 041. Previously this was computed as
  // the mode across per-profile values; now it's a constant.
  const atsThresholds = { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };

  return {
    sourcing: { fetched: sourcingFetched, totals: sourcingTotals, byProfile: sourcingByProfile },
    jd:       { totals: jdTotals, byProfile: jdByProfile },
    analysis: { totals: analysisTotals, avgAtsLift, byProfile: mkProfiles(analysisMap) },
    ats:      { totals: atsTotals, byProfile: mkProfiles(atsMap), thresholds: atsThresholds },
    applied:  { totals: appliedTotals, byProfile: mkProfiles(appliedMap) },
    callouts: {
      // Use the SAME bar as the Thin JD chip + the /?triage=thinJd
      // filter the callout links to (jobNeedsJd: thin AND no usable manual
      // JD ≥ MANUAL_JD_MIN_CHARS). jdTotals[1] counts every job classified
      // 'thin' by the analyser, even when the user has already pasted a
      // usable JD, so the callout disagreed with the filter destination.
      thinJdCount,
      passedButNoLetter:  passedButNoLetterCount,
      readyToApply:       appliedTotals[1],
    },
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

// `description` is deliberately absent: it is ~64% of this query's payload
// (~230KB across ~120 rows) and no board card renders it. The detail pane and
// the edit modal fetch it per-job from /api/jobs/[id]/board-detail instead.
const JOB_SELECT = "id, profile_id, url, title, company, location, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, starred_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email, distance_km, distance_method, employment_types, work_rights_requirement, extracted_emails, salary_period, closing_date, shift_patterns, is_agency";

export async function getDashboardData(args: {
  supabase: SupabaseClient;
  sp:       DashboardSearchParams;
  profiles: DashboardProfile[];
  prefRow:  { contact_details?: unknown } | null;
}): Promise<DashboardResult> {
  const { supabase, sp, profiles, prefRow } = args;

  const ids = profiles.map((p) => p.id);

  const mergedExcludeKeywords = [...new Set(
    profiles.flatMap((p) => (p.adzuna_exclude_keywords ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  )].join(",");

  const myCvVerticals   = readMyCvVerticals(prefRow);
  const threshByProfile = resolveProfileThresholds(profiles, myCvVerticals);
  const profileNameById = new Map(profiles.map((p) => [p.id, p.name]));

  // ── Resolve stage + build board query (sync) ─────────────────────────────

  // Active jobs (non-dismissed). location/source/posted_within narrow the dataset.
  let q = supabase.from("jobs").select(JOB_SELECT)
    .in("profile_id", ids).eq("is_expired", false).eq("is_dead_link", false)
    .is("dismissed_at", null);
  if (sp.location) q = q.ilike("location", `%${sp.location}%`);
  if (sp.source)   q = q.eq("source", sp.source);
  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date(); d.setDate(d.getDate() - days);
      q = q.gte("posted_at", d.toISOString());
    }
  }
  q = q.order("posted_at", { ascending: false, nullsFirst: false }).limit(200);

  // Dismissed jobs — fetched in parallel so the Archive chip is instant
  // (client-side filter, no server round-trip on click). Same location/source
  // filters for consistency; posted_within skipped (archived jobs are often old).
  let dq = supabase.from("jobs").select(JOB_SELECT)
    .in("profile_id", ids).eq("is_expired", false).eq("is_dead_link", false)
    .not("dismissed_at", "is", null);
  if (sp.location) dq = dq.ilike("location", `%${sp.location}%`);
  if (sp.source)   dq = dq.eq("source", sp.source);
  dq = dq.order("dismissed_at", { ascending: false, nullsFirst: false }).limit(100);

  // Jobs the user has ACTED on — applied to or starred — fetched uncapped and
  // unfiltered, then folded into the active set below.
  //
  // `?stage=applied` and `?stage=favourite` are flat VIEWS of the board (see
  // SmartFeed's isFlatStage): they render whatever `q` returned, narrowed
  // client-side. So a job the user applied to silently disappeared from their
  // Applied list once it fell outside the newest 200 by posted_at — and
  // immediately if its listing had since expired or gone dead, since `q`
  // filters both out. That is precisely backwards: scrape freshness is a
  // reason to hide a job you have never touched, and no reason at all to hide
  // one you already applied to. These rows are the user's own record of what
  // they did, so nothing but an explicit archive removes them.
  //
  // Deliberately skips the location/source/posted_within narrowing above too —
  // the flat views render no toolbar, so those params can only be leftovers
  // from the main board, and applying them would hide applied jobs based on a
  // filter the user cannot see or clear from that screen.
  //
  // Only issued for those two views. Every id this adds is also an id in the
  // `.in("job_id", jobIds)` runs/letters queries below, and that list rides in
  // the request URL — growing it on every dashboard load to fix a screen the
  // user isn't looking at would trade a rare bug for a broad one. The main
  // board's own Applied membership is unchanged (still the capped page); its
  // funnel counts already come from the uncapped `countRows`.
  // Must agree with the client's `resolveStage` — including its legacy
  // `?status=applied` alias, which SmartFeed resolves to the same flat view.
  // Testing `sp.stage` alone left that URL rendering the flat list off the
  // capped page, i.e. the bug this query exists to fix.
  const resolvedStage = sp.stage || (sp.status === "applied" ? "applied" : "");
  const isFlatStageView = resolvedStage === "applied" || resolvedStage === "favourite";
  const aq = isFlatStageView
    ? supabase.from("jobs").select(JOB_SELECT)
        .in("profile_id", ids)
        .is("dismissed_at", null)
        .or("applied_at.not.is.null,starred_at.not.is.null")
        .order("applied_at", { ascending: false, nullsFirst: false })
        .limit(400)
    : Promise.resolve({ data: [] });

  // ── BATCH 1 — five parallel queries (all only need `ids`) ─────────────────
  // Previously: 6 sequential round-trips. Now: 1 parallel batch.
  // The 3 legacy KPI queries (jobRows/unseenRows/appliedRows) are eliminated —
  // totalJobs / totalNew / totalApplied are derived from countRows below.
  // The first-run "any job at all" count rides along here too (was its own
  // serial round-trip between batch 0 and this batch) — for the common case
  // (user already has jobs) this saves a full network hop; for the rare
  // zero-job first-run case, this batch's other queries just come back empty.
  const [
    { data: jobs },
    { data: dismissedJobs },
    { data: actionedJobs },
    { data: countRows },
    { data: runLogData },
    { data: completedRuns },
    { count: anyJobCount },
  ] = await Promise.all([
    q,
    dq,
    aq,
    supabase
      .from("jobs")
      .select("id, seen_at, applied_at, dismissed_at, starred_at, profile_id, jd_quality, manual_jd_text, role_match, has_email, employment_types")
      .in("profile_id", ids)
      .eq("is_expired", false)
      .eq("is_dead_link", false),
    supabase
      .from("run_logs")
      .select("profile_id, jobs_fetched, jobs_after_dedup, jobs_saved, jobs_deduped, sources_saved")
      .in("profile_id", ids),
    // Recent completed runs per profile — the ?status=new "latest fetch" floors
    // are derived from these (see the isNewView block below).
    supabase
      .from("run_logs")
      .select("profile_id, started_at")
      .in("profile_id", ids)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(300),
    ids.length > 0
      ? supabase.from("jobs").select("id", { count: "exact", head: true }).in("profile_id", ids)
      : Promise.resolve({ count: 0 }),
  ]);

  // ── First-run gate ────────────────────────────────────────────────────────
  // Show the "ready to scan" empty state until jobs exist. The setup wizard
  // redirect is handled by SetupGateClient in the layout (client-side), so we
  // only need to handle the no-jobs case here.
  if (!((anyJobCount ?? 0) > 0)) {
    return { kind: "empty", hasProfiles: ids.length > 0 };
  }

  const isNewView = sp.status === "new";
  let activeJobs = mergeActionedJobs(
    (jobs ?? []) as ActiveJobRow[],
    (actionedJobs ?? []) as ActiveJobRow[],
  );
  if (isNewView) {
    activeJobs = narrowToLatestFetch(
      activeJobs,
      (completedRuns ?? []) as Array<{ profile_id: string; started_at: string }>,
    );
  }

  // ── Derive secondary IDs (sync) ───────────────────────────────────────────
  // Merge active + dismissed into one list so JobBoard can filter client-side.
  const jobListAll = [...activeJobs, ...(dismissedJobs ?? [])] as Array<{
    id: string; profile_id: string; applied_at: string | null; [k: string]: unknown;
  }>;
  // Work-type preference filter (Profile → Details "Work types") — board-read
  // mirror of the worker's fetch filter: hide classified jobs that don't
  // intersect the selection; unclassified always show. Applied/starred rows
  // stay visible — the user acted on them.
  const userWorkTypes = normalizeWorkTypes(
    (prefRow?.contact_details as { credentials?: { availability?: string[] } } | null)
      ?.credentials?.availability,
  );
  const jobList = jobListAll.filter((j) =>
    j.applied_at || j.starred_at ||
    passesWorkTypes(j as { employment_types?: string[] | null }, userWorkTypes),
  );
  const jobIds          = jobList.map((j) => j.id);
  // Same work-type predicate as the board list so funnel counts agree.
  const allRows         = ((countRows ?? []) as AllCountRow[]).filter((r) =>
    r.applied_at || r.starred_at || passesWorkTypes(r, userWorkTypes),
  );
  const jobIdsForCounts = allRows.map((r) => r.id);
  const activeJobRows   = allRows.filter((j) => !j.dismissed_at);
  const allActiveJobIds = activeJobRows.map((j) => j.id);

  // KPI totals — derived from allRows, no extra queries needed.
  const activeCount  = profiles.filter((p) => p.is_active).length;
  const totalJobs    = activeJobRows.length;
  const totalNew     = activeJobRows.filter((j) => !j.seen_at).length;
  const totalApplied = allRows.filter((j) => j.applied_at && !j.dismissed_at).length;

  // ── BATCH 2 — six parallel queries (need IDs from BATCH 1) ───────────────
  // Previously: 5 sequential round-trips. Now: 1 parallel batch.
  const [
    { data: recentRuns },
    { data: recentLetters },
    runsRes,
    lettersRes,
    { data: donutRunData },
    { data: donutLetterData },
  ] = await Promise.all([
    jobIds.length > 0
      ? supabase.from("analysis_runs")
          .select("id, job_id, status, tailored_pdf_storage_path, tailored_cv_storage_path, completed_at, created_at, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate, automation")
          .in("job_id", jobIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as AnalysisRunRef[] }),
    jobIds.length > 0
      ? supabase.from("cover_letters")
          .select("id, job_id, status, completed_at, created_at")
          .in("job_id", jobIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as CoverLetterRef[] }),
    jobIdsForCounts.length > 0
      ? supabase.from("analysis_runs")
          .select("job_id, tailored_cv_storage_path, tailored_pdf_storage_path, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate")
          .eq("status", "completed")
          .in("job_id", jobIdsForCounts)
      : Promise.resolve({ data: [] }),
    jobIdsForCounts.length > 0
      ? supabase.from("cover_letters")
          .select("job_id")
          .eq("status", "completed")
          .in("job_id", jobIdsForCounts)
      : Promise.resolve({ data: [] }),
    allActiveJobIds.length > 0
      ? supabase.from("analysis_runs")
          .select("job_id, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate, ats_lift, tailored_pdf_storage_path, tailored_cv_storage_path, created_at")
          .in("job_id", allActiveJobIds)
          .eq("is_stale", false)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as DonutRunRow[] }),
    allActiveJobIds.length > 0
      ? supabase.from("cover_letters")
          .select("job_id")
          .in("job_id", allActiveJobIds)
          .eq("is_stale", false)
          .eq("status", "completed")
      : Promise.resolve({ data: [] as DonutLetterRow[] }),
  ]);

  const runByJob    = indexLatestByJob((recentRuns    ?? []) as AnalysisRunRef[]);
  const letterByJob = indexLatestByJob((recentLetters ?? []) as CoverLetterRef[]);

  const typedJobs: BoardJob[] = jobList.map((j) => {
    // Per-profile thresholds — gates + band recomputed LIVE inside
    // deriveBoardJob so badges reflect threshold changes without re-analysis.
    const th = threshByProfile.get(j.profile_id) ?? { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };
    return {
      ...deriveBoardJob(j, runByJob.get(j.id), letterByJob.get(j.id), th),
      profile_name: profileNameById.get(j.profile_id) ?? null,
    };
  });

  const funnelCounts = computeFunnelCounts({
    allRows,
    runsData:    (runsRes.data ?? []) as Parameters<typeof computeFunnelCounts>[0]["runsData"],
    lettersData: (lettersRes.data ?? []) as Array<{ job_id: string }>,
    threshByProfile,
    totalNew,
  });

  const lensData = computeLensData({
    ids,
    profileNameById,
    activeJobRows,
    runLogData:      (runLogData ?? []) as RunLogRow[],
    donutRunData:    (donutRunData ?? []) as DonutRunRow[],
    donutLetterData: (donutLetterData ?? []) as DonutLetterRow[],
    threshByProfile,
    thinJdCount:     funnelCounts.thinJd,
  });

  return {
    kind: "ready",
    data: {
      typedJobs,
      funnelCounts,
      lensData,
      totalJobs,
      totalNew,
      totalApplied,
      activeCount,
      mergedExcludeKeywords,
      isNewView,
    },
  };
}
