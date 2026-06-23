/**
 * Main dashboard — two-part layout:
 *
 *   1. Profile management   — KPI strip + profiles table (existing).
 *   2. Unified jobs board   — JobTable across ALL profiles owned by the
 *      user, with the same chips/filters/sort/rail as a single-profile
 *      board. Each row shows a small "via <Profile name>" label.
 *
 * Three queries + JS stitching for the jobs board (matches the
 * per-profile pattern):
 *   - jobs IN (user's profile_ids)
 *   - analysis_runs IN (jobIds) — non-stale, ordered DESC
 *   - cover_letters IN (jobIds) — non-stale, ordered DESC
 *
 * URL params reused 1:1 from the per-profile board:
 *   status, sort, dir, location, posted_within, min_keywords,
 *   visa_toggle, chips
 */

import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/getUser";
import { getCachedProfiles } from "@/lib/queryCache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { MIN_INITIAL_ATS, MIN_FINAL_ATS, resolveThresholds } from "@/lib/atsThresholds";
import { Suspense } from "react";
import Link from "next/link";
import { SetupCards } from "@/components/onboarding/SetupCards";
import { HowItWorksDeck } from "@/components/onboarding/HowItWorksDeck";
import { getSetupStatus, type SetupStatus } from "@/lib/setupStatus";
import { firstIncompleteStep } from "@/lib/setupSteps";
import { type ThinJdJob } from "@/components/jobs/BulkThinJdButton";
import { DashboardStatCards } from "@/components/dashboard/DashboardStatCards";
import { PipelineDonut, type PipelineLensData } from "@/components/dashboard/PipelineDonut";
import { type FunnelCounts } from "@/components/jobs/PipelineFunnel";
import { ScrollToJobsOnFilter } from "@/components/jobs/ScrollToJobsOnFilter";
import { JobBoard } from "@/components/jobs/JobBoard";
import { atsBandFor, jobNeedsJd, type BoardJob } from "@/components/jobs/jobFilters";
import {
  deriveProgress,
  indexLatestByJob,
  type AnalysisRunRef,
  type CoverLetterRef,
} from "@/components/jobs/progressFlags";
import { derivePipelineState, recomputeGates } from "@/components/jobs/pipelineState";

interface SearchParams {
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

/** Map the new ?stage= param (or legacy ?status=) to a stage key */
function resolveStage(sp: SearchParams): string {
  if (sp.stage) return sp.stage;
  // Backward compat: map old ?status= to new stages
  if (sp.status === "applied") return "applied";
  if (sp.status === "dismissed") return "dismissed";
  // Old chips backward compat
  if (sp.chips?.includes("analysed") && sp.chips?.includes("hasLetter")) return "letterReady";
  if (sp.chips?.includes("analysed") && sp.chips?.includes("hasCv")) return "cvReady";
  if (sp.chips?.includes("analysed")) return "analysed";
  return "all";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  // getAuthUser is React.cache() — free if layout already called it this render.
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  // Admins/founders have no use for the user-facing job board dashboard.
  // Send them straight to the admin overview instead — UNLESS they've opted
  // into "View as user" (jt_user_view cookie), in which case let them see the
  // user dashboard with their own data.
  const { data: userRoleRow } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  const userRole = (userRoleRow as { role?: string } | null)?.role ?? "";
  const inUserView = (await cookies()).get("jt_user_view")?.value === "1";
  if ((userRole === "founder" || userRole === "admin") && !inUserView) redirect("/dashboard/admin");

  // getCachedProfiles is unstable_cache — 30 s TTL per user, instant on repeat
  // visits within a session. Busted by revalidateTag(`profiles-${user.id}`)
  // on createProfile / updateProfile / deleteProfile.
  const profileRows = await getCachedProfiles(user.id);

  const profiles = profileRows as Array<{
    id: string; name: string; is_active: boolean;
    keywords: string[]; location: string; schedule_cron: string;
    target_verticals?: string[] | null;
  }>;
  const ids = profiles.map((p) => p.id);

  // ATS thresholds are resolved per-vertical (e.g. 55/65 for healthcare/nursing).
  // The threshold map maps each profile ID to its specific thresholds.
  const DEFAULT_MIN_INITIAL = MIN_INITIAL_ATS;
  const DEFAULT_MIN_FINAL   = MIN_FINAL_ATS;
  const threshByProfile = new Map<string, { initial: number; final: number }>(
    profiles.map((p) => [p.id, resolveThresholds(p.target_verticals)]),
  );

  // ── First-run gate ────────────────────────────────────────────────────────
  // Show the setup wizard until the first pipeline run produces data. Covers both
  // a brand-new user (no profiles) and a user with a profile that hasn't run.
  let hasAnyJob = false;
  if (ids.length > 0) {
    const { count } = await supabase
      .from("jobs").select("id", { count: "exact", head: true }).in("profile_id", ids);
    hasAnyJob = (count ?? 0) > 0;
  }
  if (!hasAnyJob) {
    const status = await getSetupStatus(user.id, ids);
    // Mode A — core setup unfinished (personal profile + CV + AI key): guided wizard.
    // Mode B — core done but no jobs yet (no search profile, or profiles/runs
    //          deleted): "ready to scan" screen with a create-profile CTA + the
    //          How-it-works deck so the empty dashboard still teaches.
    const coreComplete = status.profile && status.cv && status.aiKey;
    if (!coreComplete) return <FirstRunScreen status={status} />;
    return <ReadyToScanScreen hasProfiles={ids.length > 0} />;
  }

  const profileNameById = new Map(profiles.map((p) => [p.id, p.name]));

  // ── Resolve stage + build board query (sync) ─────────────────────────────
  // Type declarations shared across both fetch batches
  interface AllCountRow {
    id: string; seen_at: string | null; applied_at: string | null;
    dismissed_at: string | null; starred_at: string | null; profile_id: string;
    jd_quality: string | null; manual_jd_text: string | null;
    role_match: string | null; has_email: boolean | null;
  }
  interface DonutRunRow {
    job_id: string; initial_ats_score: number | null; tailored_match_score: number | null;
    passed_initial_gate: boolean | null; passed_final_gate: boolean | null;
    ats_lift: number | null; tailored_pdf_storage_path: string | null;
    tailored_cv_storage_path: string | null; created_at: string | null;
  }
  interface DonutLetterRow { job_id: string }

  const JOB_SELECT = "id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, starred_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email, distance_km, distance_method";

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

  // ── BATCH 1 — four parallel queries (all only need `ids`) ─────────────────
  // Previously: 6 sequential round-trips. Now: 1 parallel batch.
  // The 3 legacy KPI queries (jobRows/unseenRows/appliedRows) are eliminated —
  // totalJobs / totalNew / totalApplied are derived from countRows below.
  const [
    { data: jobs },
    { data: dismissedJobs },
    { data: countRows },
    { data: runLogData },
  ] = await Promise.all([
    q,
    dq,
    supabase
      .from("jobs")
      .select("id, seen_at, applied_at, dismissed_at, starred_at, profile_id, jd_quality, manual_jd_text, role_match, has_email")
      .in("profile_id", ids)
      .eq("is_expired", false)
      .eq("is_dead_link", false),
    supabase
      .from("run_logs")
      .select("profile_id, jobs_fetched, jobs_after_dedup, jobs_saved, jobs_deduped, sources_saved")
      .in("profile_id", ids),
  ]);

  // ── Derive secondary IDs (sync) ───────────────────────────────────────────
  // Merge active + dismissed into one list so JobBoard can filter client-side.
  const jobList = [...(jobs ?? []), ...(dismissedJobs ?? [])] as Array<{
    id: string; profile_id: string; applied_at: string | null; [k: string]: unknown;
  }>;
  const jobIds          = jobList.map((j) => j.id);
  const allRows         = (countRows ?? []) as AllCountRow[];
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
    const run    = runByJob.get(j.id);
    const letter = letterByJob.get(j.id);
    const progress = deriveProgress(
      { applied_at: j.applied_at },
      run,
      letter,
    );
    // Recompute gates LIVE from stored scores vs this profile's current
    // thresholds, so state badges reflect threshold changes without re-analysis.
    const th = threshByProfile.get(j.profile_id) ?? { initial: DEFAULT_MIN_INITIAL, final: DEFAULT_MIN_FINAL };
    const g = run ? recomputeGates(run.initial_ats_score, run.tailored_match_score, th.initial, th.final) : null;
    const liveRun = run && g
      ? { ...run, passed_initial_gate: g.passedInitial, passed_final_gate: g.passedFinal }
      : run;
    const pipelineState = derivePipelineState({
      job: {
        applied_at:   j.applied_at,
        dismissed_at: (j.dismissed_at as string | null) ?? null,
        has_email:    (j.has_email    as boolean | null) ?? null,
        jd_quality:   (j.jd_quality   as string  | null) ?? null,
        role_match:   (j.role_match   as string  | null) ?? null,
      },
      latestRun:    liveRun,
      latestLetter: letter,
    });
    // Precompute the ATS band so the client can filter by it without re-deriving
    // gates (mirrors the donut's ATS lens buckets exactly).
    const atsBand = atsBandFor(
      !!run,
      run?.initial_ats_score ?? null,
      run?.tailored_match_score ?? null,
      th.initial,
      th.final
    );
    return {
      ...(j as unknown as BoardJob),
      profile_name:         profileNameById.get(j.profile_id) ?? null,
      progress,
      pipelineState,
      atsBand,
      atsThresholds:        th,
      initial_ats_score:    run?.initial_ats_score    ?? null,
      tailored_match_score: run?.tailored_match_score ?? null,
    };
  });

  // Thin-JD jobs in the loaded board — fed to the bulk "Fix thin JDs" modal.
  // Captured before the stage/triage filters below mutate typedJobs.
  const thinJdJobs: ThinJdJob[] = typedJobs
    .filter((x) => !x.dismissed_at && jobNeedsJd(x))
    .map((x) => ({
      id:             x.id,
      title:          x.title ?? null,
      company:        x.company ?? null,
      description:    (x as { description?: string | null }).description ?? null,
      manual_jd_text: (x as { manual_jd_text?: string | null }).manual_jd_text ?? null,
    }));

  let funnelCounts: FunnelCounts = {
    discovered: 0, analysed: 0, cvReady: 0, letterReady: 0, applied: 0, dismissed: 0, favourite: 0, newCount: 0,
    needsJd: 0, roleMismatch: 0, belowThreshold: 0, hasEmail: 0, thinJd: 0, richJd: 0
  };

  // View filtering (stage / triage / ATS band / min-keywords) and sorting now
  // happen instantly client-side in <JobBoard> from this full loaded set — no
  // server round-trip per filter change. The counts below are global (not
  // filter-dependent), so they stay correct without recomputation.

  const analysedSet = new Set((runsRes.data ?? []).map((r) => r.job_id));
  const cvReadySet = new Set((runsRes.data ?? []).filter((r) => r.tailored_cv_storage_path || r.tailored_pdf_storage_path).map((r) => r.job_id));
  const letterReadySet = new Set((lettersRes.data ?? []).map((l) => l.job_id));
  // "Below ATS" = failed either gate, recomputed LIVE from stored scores vs the
  // job's profile thresholds (not the frozen passed_*_gate booleans).
  const profileByJobId = new Map(allRows.map((j) => [j.id, j.profile_id]));
  const belowThresholdSet = new Set(
    (runsRes.data ?? [])
      .filter((r) => {
        const th = threshByProfile.get(profileByJobId.get(r.job_id) ?? "") ?? { initial: DEFAULT_MIN_INITIAL, final: DEFAULT_MIN_FINAL };
        const g = recomputeGates(
          (r as { initial_ats_score?: number | null }).initial_ats_score,
          (r as { tailored_match_score?: number | null }).tailored_match_score,
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

  funnelCounts = {
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

  // ── Pipeline donut: lens computation ────────────────────────────────────────
  // (runLogData, donutRunData, donutLetterData fetched in BATCH 2 above)

  // ── Lens data computation ─────────────────────────────────────────────────────

  // Sourcing: aggregate run_logs lifetime totals per profile
  interface RunLogRow {
    profile_id: string;
    jobs_fetched: number | null;
    jobs_after_dedup: number | null;
    jobs_saved: number | null;
    jobs_deduped: number | null;
    sources_saved: Record<string, number> | null;
  }
  const srcMap: Record<string, { saved: number; dupes: number; filtered: number; sourcesSaved: Record<string, number> }> = {};
  for (const r of (runLogData ?? []) as RunLogRow[]) {
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
  const sourcingFetched  = (runLogData ?? []).reduce<number>((a, r) => a + ((r as RunLogRow).jobs_fetched ?? 0), 0);
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
  for (const r of (donutRunData ?? []) as DonutRunRow[]) {
    if (!latestDonutRunByJob.has(r.job_id)) latestDonutRunByJob.set(r.job_id, r);
  }
  const letterJobIds = new Set(((donutLetterData ?? []) as DonutLetterRow[]).map((l) => l.job_id));

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
      const th = threshByProfile.get(pid) ?? { initial: DEFAULT_MIN_INITIAL, final: DEFAULT_MIN_FINAL };
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

  const lensData: PipelineLensData = {
    sourcing: { fetched: sourcingFetched, totals: sourcingTotals, byProfile: sourcingByProfile },
    jd:       { totals: jdTotals, byProfile: jdByProfile },
    analysis: { totals: analysisTotals, avgAtsLift, byProfile: mkProfiles(analysisMap) },
    ats:      { totals: atsTotals, byProfile: mkProfiles(atsMap), thresholds: atsThresholds },
    applied:  { totals: appliedTotals, byProfile: mkProfiles(appliedMap) },
    callouts: {
      // Use the SAME bar as the Thin JD chip + the /dashboard?triage=thinJd
      // filter the callout links to (jobNeedsJd: thin AND no usable manual
      // JD ≥ MANUAL_JD_MIN_CHARS). jdTotals[1] counts every job classified
      // 'thin' by the analyser, even when the user has already pasted a
      // usable JD, so the callout disagreed with the filter destination.
      thinJdCount:        funnelCounts.thinJd,
      passedButNoLetter:  passedButNoLetterCount,
      readyToApply:       appliedTotals[1],
    },
  };

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-semibold text-text">Dashboard</h1>
            <p className="text-[12px] text-text-2 mt-0.5">
              {profiles.length} profile{profiles.length !== 1 ? "s" : ""} · {activeCount} auto-scheduled
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* ── KPI bar (interactive) ── */}
        <DashboardStatCards
          totalJobs={totalJobs}
          totalNew={totalNew}
          totalApplied={totalApplied}
          activeCount={activeCount}
        />

        {/* ── Pipeline analytics donut ── */}
        <PipelineDonut data={lensData} shallow />

        {/* ── Unified jobs board (client-side instant filtering) ── */}
        <div id="jobs-board" className="anim-in anim-delay-2 space-y-4 pt-2 scroll-mt-4">
          {/* Smoothly scrolls here whenever a filter/sort changes. */}
          <Suspense><ScrollToJobsOnFilter /></Suspense>
          <Suspense>
            <JobBoard
              jobs={typedJobs}
              counts={funnelCounts}
              thinJdJobs={thinJdJobs}
              sourceParam={sp.source}
            />
          </Suspense>
        </div>

        {/* Quick links */}
        <div className="flex items-center gap-3 text-[12px] text-text-3 anim-in anim-delay-3">
          <a href="/api/user/export" className="hover:text-text transition-colors">Export all data</a>
          <span>·</span>
          <Link href="/privacy" className="hover:text-text transition-colors">Privacy policy</Link>
        </div>
      </div>
    </div>
  );
}

/**
 * First-run screen — shown until the first pipeline run produces data. Drops
 * the user into the guided-setup wizard at the first incomplete step.
 */
function FirstRunScreen({ status }: { status: SetupStatus }) {
  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Welcome to JobTrackr</h1>
        <p className="text-[12px] text-text-2 mt-0.5">
          Let&apos;s get you set up — your job feed appears here after your first run.
        </p>
      </div>

      <div className="px-6 py-10">
        <SetupCards status={status} initialStep={firstIncompleteStep(status)} />
        <p className="text-center text-[12px] text-text-3 mt-5">
          Want the full picture?{" "}
          <Link href="/dashboard/instructions?tab=howitworks" className="text-[var(--brand)] hover:underline">
            Read the instructions →
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * "Ready to scan" empty state — core setup is done but there are no jobs yet
 * (no search profile created, or all profiles/runs were deleted). Surfaces the
 * one action that produces jobs, with the How-it-works deck below so the empty
 * dashboard teaches instead of sitting blank.
 */
function ReadyToScanScreen({ hasProfiles }: { hasProfiles: boolean }) {
  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Ready to scan</h1>
        <p className="text-[12px] text-text-2 mt-0.5">
          {hasProfiles
            ? "Your setup is done — run a search profile and your AI-ranked feed appears here."
            : "Your setup is done — create a search profile and your AI-ranked feed appears here."}
        </p>
      </div>

      <div className="px-6 py-8 max-w-5xl mx-auto space-y-8">
        {/* Primary action */}
        <div className="bg-surface border border-border rounded-xl p-6 sm:p-8 text-center anim-in">
          <h2 className="text-[18px] font-semibold text-text mb-1.5">
            {hasProfiles ? "Run a scan to fill your feed" : "Create your first search profile"}
          </h2>
          <p className="text-[13px] text-text-2 leading-relaxed mb-5 max-w-md mx-auto">
            {hasProfiles
              ? "You have a search profile but no jobs yet. Run it to pull listings from every source for your keywords + location."
              : "Your job radar: keywords + location + schedule. Save it, then run it — your first AI-scored results land in a minute or two."}
          </p>
          <Link
            href={hasProfiles ? "/dashboard/profiles" : "/dashboard/profiles/new"}
            className="gh-btn gh-btn-blue text-[14px] px-5 py-2.5 inline-flex items-center gap-1.5 font-semibold"
          >
            {hasProfiles ? "Go to your profiles" : "Create a search profile"}
          </Link>
          <p className="text-[12px] text-text-3 mt-4">
            Need to change your details?{" "}
            <Link href="/dashboard/instructions?tab=setup" className="text-[var(--brand)] hover:underline">
              Revisit setup →
            </Link>
          </p>
        </div>

        {/* Educational deck */}
        <div>
          <h2 className="text-[13px] font-semibold text-text mb-3 text-center">How it works</h2>
          <HowItWorksDeck />
        </div>
      </div>
    </div>
  );
}
