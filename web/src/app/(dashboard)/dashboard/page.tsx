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
import { redirect } from "next/navigation";
import { MIN_INITIAL_ATS, MIN_FINAL_ATS } from "@/lib/atsThresholds";
import { Suspense } from "react";
import Link from "next/link";
import { SetupGuide } from "@/components/onboarding/SetupGuide";
import { getSetupStatus, type SetupStatus } from "@/lib/setupStatus";
import { BulkThinJdButton, type ThinJdJob } from "@/components/jobs/BulkThinJdButton";
import { DashboardStatCards } from "@/components/dashboard/DashboardStatCards";
import { PipelineDonut, type PipelineLensData } from "@/components/dashboard/PipelineDonut";
import { JobTable, type Job } from "@/components/jobs/JobTable";
import { PipelineFunnel, type FunnelCounts } from "@/components/jobs/PipelineFunnel";
import { SmartFilterBar } from "@/components/jobs/SmartFilterBar";
import { ScrollToJobsOnFilter } from "@/components/jobs/ScrollToJobsOnFilter";
import { ContinueRail, type RailJob } from "@/components/jobs/ContinueRail";
import { JobBoardSettingsPanel } from "@/components/jobs/JobBoardSettings";
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, keywords, location, schedule_cron")
    .order("created_at", { ascending: false });

  const profiles = (profileRows ?? []) as Array<{
    id: string; name: string; is_active: boolean;
    keywords: string[]; location: string; schedule_cron: string;
  }>;
  const ids = profiles.map((p) => p.id);

  // ATS thresholds are global (migration 041). Same value for every profile.
  // The threshold map remains in shape so downstream code that looked up
  // per-profile values keeps working without restructuring; values are
  // identical for every entry.
  const DEFAULT_MIN_INITIAL = MIN_INITIAL_ATS;
  const DEFAULT_MIN_FINAL   = MIN_FINAL_ATS;
  const threshByProfile = new Map<string, { initial: number; final: number }>(
    profiles.map((p) => [p.id, { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS }]),
  );

  // ── First-run gate ────────────────────────────────────────────────────────
  // Show the SetupGuide until the first pipeline run produces data. Covers both
  // a brand-new user (no profiles) and a user with a profile that hasn't run.
  let hasAnyJob = false;
  if (ids.length > 0) {
    const { count } = await supabase
      .from("jobs").select("id", { count: "exact", head: true }).in("profile_id", ids);
    hasAnyJob = (count ?? 0) > 0;
  }
  if (!hasAnyJob) {
    const status = await getSetupStatus(user.id, ids);
    return <FirstRunScreen status={status} />;
  }

  const profileNameById = new Map(profiles.map((p) => [p.id, p.name]));

  // ── Summary queries for the KPI strip ────────────────────────────────────
  // The per-profile latest-run breakdown lives on /dashboard/profiles now —
  // this page only needs the aggregate counts feeding the four KPIs.
  const [
    { data: jobRows },
    { data: unseenRows },
    { data: appliedRows },
  ] = await Promise.all([
    supabase.from("jobs").select("profile_id").in("profile_id", ids)
      .eq("is_expired", false).eq("is_dead_link", false).is("dismissed_at", null),
    supabase.from("jobs").select("profile_id").in("profile_id", ids)
      .eq("is_expired", false).eq("is_dead_link", false).is("seen_at", null).is("dismissed_at", null),
    supabase.from("jobs").select("profile_id").in("profile_id", ids).not("applied_at", "is", null),
  ]);

  function countBy(rows: { profile_id: string }[] | null) {
    return ((rows ?? []) as { profile_id: string }[]).reduce<Record<string, number>>(
      (acc, r) => { acc[r.profile_id] = (acc[r.profile_id] ?? 0) + 1; return acc; }, {}
    );
  }

  const totalCounts   = countBy(jobRows);
  const unseenCounts  = countBy(unseenRows);
  const appliedCounts = countBy(appliedRows);

  const totalJobs    = Object.values(totalCounts).reduce((a, b) => a + b, 0);
  const totalNew     = Object.values(unseenCounts).reduce((a, b) => a + b, 0);
  const totalApplied = Object.values(appliedCounts).reduce((a, b) => a + b, 0);
  const activeCount  = profiles.filter((p) => p.is_active).length;

  // ── Resolve stage from URL params ─────────────────────────────────────────
  const currentStage = resolveStage(sp);
  const currentTriage = sp.triage || "";

  // ── Unified jobs board: data fetch ───────────────────────────────────────
  let q = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email")
    .in("profile_id", ids)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  // Stage-based server-side filtering
  if (currentStage === "applied")        q = q.not("applied_at", "is", null);
  else if (currentStage === "dismissed") q = q.not("dismissed_at", "is", null);
  else                                   q = q.is("dismissed_at", null);

  if (sp.location) q = q.ilike("location", `%${sp.location}%`);

  if (sp.source) q = q.eq("source", sp.source);

  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      q = q.gte("posted_at", d.toISOString());
    }
  }

  const sortCol = sp.sort ?? "posted_at";
  const sortDir = sp.dir === "asc";
  const allowed = ["title", "company", "location", "posted_at", "created_at", "visa_likelihood"];
  q = allowed.includes(sortCol)
    ? q.order(sortCol, { ascending: sortDir, nullsFirst: false })
    : q.order("posted_at", { ascending: false, nullsFirst: false });

  q = q.limit(200);
  const { data: jobs } = await q;
  let jobList = (jobs ?? []) as Array<{
    id: string; profile_id: string; applied_at: string | null; [k: string]: unknown;
  }>;

  if (sp.min_keywords) {
    const minK = parseInt(sp.min_keywords, 10);
    if (!isNaN(minK)) {
      jobList = jobList.filter((j) => ((j.keywords_matched as string[] | null)?.length ?? 0) >= minK);
    }
  }

  const jobIds = jobList.map((j) => j.id);

  const { data: recentRuns } = jobIds.length > 0
    ? await supabase
        .from("analysis_runs")
        .select("id, job_id, status, tailored_pdf_storage_path, tailored_cv_storage_path, completed_at, created_at, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate, automation")
        .in("job_id", jobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as AnalysisRunRef[] };

  const { data: recentLetters } = jobIds.length > 0
    ? await supabase
        .from("cover_letters")
        .select("id, job_id, status, completed_at, created_at")
        .in("job_id", jobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as CoverLetterRef[] };

  const runByJob    = indexLatestByJob((recentRuns    ?? []) as AnalysisRunRef[]);
  const letterByJob = indexLatestByJob((recentLetters ?? []) as CoverLetterRef[]);

  let typedJobs: Job[] = jobList.map((j) => {
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
    const liveRun = run
      ? (() => {
          const g = recomputeGates(run.initial_ats_score, run.tailored_match_score, th.initial, th.final);
          return { ...run, passed_initial_gate: g.passedInitial, passed_final_gate: g.passedFinal };
        })()
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
    return {
      ...(j as unknown as Job),
      profile_name: profileNameById.get(j.profile_id) ?? null,
      progress,
      pipelineState,
    };
  });

  // Thin-JD jobs in the loaded board — fed to the bulk "Fix thin JDs" modal.
  // Captured before the stage/triage filters below mutate typedJobs.
  const thinJdJobs: ThinJdJob[] = typedJobs
    .filter((x) => x.jd_quality === "thin")
    .map((x) => ({
      id:             x.id,
      title:          x.title ?? null,
      company:        x.company ?? null,
      description:    (x as { description?: string | null }).description ?? null,
      manual_jd_text: (x as { manual_jd_text?: string | null }).manual_jd_text ?? null,
    }));

  // Declare funnelCounts as a mutable variable, populated below using the global countRows query
  let funnelCounts: FunnelCounts = {
    discovered: 0, analysed: 0, cvReady: 0, letterReady: 0, applied: 0, dismissed: 0, newCount: 0,
    needsJd: 0, roleMismatch: 0, belowThreshold: 0, hasEmail: 0, thinJd: 0, richJd: 0
  };

  const railJobs: RailJob[] = [...typedJobs]
    .filter((x) => x.progress.last_progress_at !== null && !x.dismissed_at)
    .sort((a, b) =>
      (b.progress.last_progress_at ?? "").localeCompare(a.progress.last_progress_at ?? ""),
    )
    .slice(0, 3)
    .map((x) => ({
      id:         x.id,
      profile_id: x.profile_id,
      title:      x.title,
      company:    x.company,
      progress:   x.progress,
    }));

  // ── Stage filter (replaces old chip filter) ──────────────────────────────
  if (currentStage === "analysed") {
    typedJobs = typedJobs.filter((x) => x.progress.has_analysis);
  } else if (currentStage === "cvReady") {
    typedJobs = typedJobs.filter((x) => x.progress.has_tailored_cv);
  } else if (currentStage === "letterReady") {
    typedJobs = typedJobs.filter((x) => x.progress.has_cover_letter);
  } else if (currentStage === "thinJd") {
    typedJobs = typedJobs.filter((x) => x.jd_quality === "thin");
  }
  // applied + dismissed are handled server-side above

  // ── Triage sub-filter ────────────────────────────────────────────────────
  if (currentTriage === "needsJd" || currentTriage === "thinJd") {
    typedJobs = typedJobs.filter((x) => x.jd_quality === "thin");
  } else if (currentTriage === "richJd") {
    typedJobs = typedJobs.filter((x) => x.jd_quality === "rich");
  } else if (currentTriage === "roleMismatch") {
    typedJobs = typedJobs.filter((x) => x.role_match === "mismatch");
  } else if (currentTriage === "belowThreshold") {
    typedJobs = typedJobs.filter((x) =>
      x.pipelineState === "below_initial" || x.pipelineState === "below_final"
    );
  } else if (currentTriage === "hasEmail") {
    typedJobs = typedJobs.filter((x) => x.has_email === true);
  } else if (currentTriage === "notTailored") {
    // Analysis lens "Not tailored" slice — jobs without a tailored CV yet
    // (includes un-analysed jobs), mirroring the donut's analysis bucket 2.
    typedJobs = typedJobs.filter((x) => !x.progress.has_tailored_cv);
  }

  // ── ATS-score band filter (SmartFilterBar dropdown + donut CTAs) ──────────
  // Recompute gates LIVE from stored scores vs the profile's current thresholds
  // so bands match the ATS donut exactly (and respond to threshold changes).
  if (sp.ats) {
    typedJobs = typedJobs.filter((x) => {
      const run = runByJob.get(x.id);
      if (sp.ats === "no_ats") return !run;
      if (!run) return false;
      const th = threshByProfile.get(x.profile_id) ?? { initial: DEFAULT_MIN_INITIAL, final: DEFAULT_MIN_FINAL };
      const g = recomputeGates(run.initial_ats_score, run.tailored_match_score, th.initial, th.final);
      if (sp.ats === "above_final")   return g.passedFinal === true;
      if (sp.ats === "below_final")   return g.passedFinal !== true && !!g.passedInitial;
      if (sp.ats === "below_initial") return g.passedFinal !== true && !g.passedInitial;
      return true;
    });
  }

  if (sortCol === "rich_jd_first") {
    const rank: Record<string, number> = { rich: 1, unknown: 2, thin: 3 };
    typedJobs = [...typedJobs].sort((a, b) => {
      const aR = rank[a.jd_quality ?? ""] ?? 4;
      const bR = rank[b.jd_quality ?? ""] ?? 4;
      if (aR !== bR) return sortDir ? bR - aR : aR - bR;
      return (b.posted_at ?? "").localeCompare(a.posted_at ?? "");
    });
  } else if (sortCol === "recently_progressed") {
    typedJobs = [...typedJobs].sort((a, b) => {
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return sortDir ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  } else if (sortCol === "most_progressed") {
    typedJobs = [...typedJobs].sort((a, b) => {
      const ds = b.progress.progress_score - a.progress.progress_score;
      if (ds !== 0) return sortDir ? -ds : ds;
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return sortDir ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  }

  // Status-tab counts — aggregated across profiles
  const { data: countRows } = await supabase
    .from("jobs")
    .select("id, seen_at, applied_at, dismissed_at, profile_id, jd_quality, role_match, has_email")
    .in("profile_id", ids)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  interface AllCountRow {
    id: string;
    seen_at: string | null;
    applied_at: string | null;
    dismissed_at: string | null;
    profile_id: string;
    jd_quality: string | null;
    role_match: string | null;
    has_email: boolean | null;
  }
  const allRows = (countRows ?? []) as AllCountRow[];
  const jobIdsForCounts = allRows.map((r) => r.id);

  const [runsRes, lettersRes] = jobIdsForCounts.length > 0
    ? await Promise.all([
        supabase
          .from("analysis_runs")
          .select("job_id, tailored_cv_storage_path, tailored_pdf_storage_path, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate")
          .eq("is_stale", false)
          .eq("status", "completed")
          .in("job_id", jobIdsForCounts),
        supabase
          .from("cover_letters")
          .select("job_id")
          .eq("is_stale", false)
          .eq("status", "completed")
          .in("job_id", jobIdsForCounts)
      ])
    : [{ data: [] }, { data: [] }];

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
  const tabAppliedCount = allRows.filter((j) => j.applied_at).length;
  const tabDismissedCount = allRows.filter((j) => j.dismissed_at).length;

  funnelCounts = {
    discovered:     tabTotalCount,
    analysed:       allRows.filter((j) => !j.dismissed_at && analysedSet.has(j.id)).length,
    cvReady:        allRows.filter((j) => !j.dismissed_at && cvReadySet.has(j.id)).length,
    letterReady:    allRows.filter((j) => !j.dismissed_at && letterReadySet.has(j.id)).length,
    applied:        tabAppliedCount,
    dismissed:      tabDismissedCount,
    newCount:       totalNew,
    needsJd:        allRows.filter((j) => !j.dismissed_at && j.jd_quality === "thin").length,
    roleMismatch:   allRows.filter((j) => !j.dismissed_at && j.role_match === "mismatch").length,
    belowThreshold: allRows.filter((j) => !j.dismissed_at && belowThresholdSet.has(j.id)).length,
    hasEmail:       allRows.filter((j) => !j.dismissed_at && j.has_email === true).length,
    thinJd:         allRows.filter((j) => !j.dismissed_at && j.jd_quality === "thin").length,
    richJd:         allRows.filter((j) => !j.dismissed_at && j.jd_quality === "rich").length,
  };

  // ── Pipeline donut: additional queries ───────────────────────────────────────
  interface DonutRunRow {
    job_id: string;
    initial_ats_score: number | null;
    tailored_match_score: number | null;
    passed_initial_gate: boolean | null;
    passed_final_gate: boolean | null;
    ats_lift: number | null;
    tailored_pdf_storage_path: string | null;
    tailored_cv_storage_path: string | null;
    created_at: string | null;
  }
  interface DonutLetterRow { job_id: string }

  const activeJobRows   = allRows.filter((j) => !j.dismissed_at);
  const allActiveJobIds = activeJobRows.map((j) => j.id);

  const { data: runLogData } = await supabase
    .from("run_logs")
    .select("profile_id, jobs_fetched, jobs_after_dedup, jobs_saved, jobs_deduped, sources_saved")
    .in("profile_id", ids);

  const { data: donutRunData } = allActiveJobIds.length > 0
    ? await supabase
        .from("analysis_runs")
        .select("job_id, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate, ats_lift, tailored_pdf_storage_path, tailored_cv_storage_path, created_at")
        .in("job_id", allActiveJobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as DonutRunRow[] };

  const { data: donutLetterData } = allActiveJobIds.length > 0
    ? await supabase
        .from("cover_letters")
        .select("job_id")
        .in("job_id", allActiveJobIds)
        .eq("is_stale", false)
    : { data: [] as DonutLetterRow[] };

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
      thinJdCount:        jdTotals[1],
      passedButNoLetter:  passedButNoLetterCount,
      readyToApply:       appliedTotals[1],
    },
  };

  const currentTab = currentStage;

  // Human labels for the active filter, so the job board can announce what
  // it's showing (e.g. after a donut "View full-JD jobs" click).
  const FILTER_LABELS: Record<string, string> = {
    analysed: "Analysed", cvReady: "CV ready", letterReady: "Letter ready",
    thinJd: "Thin JD", applied: "Applied", dismissed: "Archived",
    richJd: "Full JD", roleMismatch: "Role mismatch", belowThreshold: "Below threshold",
    hasEmail: "Has email", notTailored: "Not tailored", needsJd: "Thin JD",
    above_final: "Above final", below_final: "Below final",
    below_initial: "Below initial", no_ats: "No ATS",
  };
  const activeFilters: string[] = [];
  if (currentStage !== "all") activeFilters.push(FILTER_LABELS[currentStage] ?? currentStage);
  if (currentTriage)          activeFilters.push(FILTER_LABELS[currentTriage] ?? currentTriage);
  if (sp.ats)                 activeFilters.push(FILTER_LABELS[sp.ats] ?? sp.ats);

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
          <div className="flex items-center gap-2">
            <JobBoardSettingsPanel />
            <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue text-[13px]">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              New profile
            </Link>
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
        <PipelineDonut data={lensData} />

        {/* ── Unified jobs board ── */}
        <div id="jobs-board" className="anim-in anim-delay-2 space-y-4 pt-2 scroll-mt-4">
          {/* Smoothly scrolls here whenever a filter/sort changes. */}
          <Suspense><ScrollToJobsOnFilter /></Suspense>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[14px] font-semibold text-text">
                {activeFilters.length > 0 ? `Jobs · ${activeFilters.join(" · ")}` : "All jobs across profiles"}
              </h2>
              <span className="text-[12px] text-text-3">{typedJobs.length}</span>
              {activeFilters.length > 0 && (
                <Link
                  href="/dashboard"
                  scroll={false}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-2 hover:text-text transition-colors"
                >
                  <span>Clear filter</span>
                  <span aria-hidden>✕</span>
                </Link>
              )}
              {sp.source && (
                <Link
                  href="/dashboard"
                  scroll={false}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-2 hover:text-text transition-colors"
                >
                  <span className="capitalize">Source: {sp.source}</span>
                  <span aria-hidden>✕</span>
                </Link>
              )}
            </div>
            <BulkThinJdButton jobs={thinJdJobs} />
          </div>

          {/* Pipeline funnel */}
          <Suspense>
            <PipelineFunnel counts={funnelCounts} currentStage={currentStage} excludeStages={["all", "applied"]} />
          </Suspense>

          {/* Smart filter bar */}
          <Suspense>
            <SmartFilterBar total={typedJobs.length} showKeywords={false} showAtsFilter />
          </Suspense>

          {/* Continue rail */}
          <ContinueRail jobs={railJobs} currentTab={currentTab} />

          {/* Job table */}
          <JobTable
            jobs={typedJobs}
            showVisa={sp.visa_toggle === "1"}
            currentTab={currentTab}
          />
        </div>

        {/* Quick links */}
        <div className="flex items-center gap-3 text-[12px] text-text-3 anim-in anim-delay-3">
          <Link href="/dashboard/profiles/new" className="hover:text-text transition-colors">+ New profile</Link>
          <span>·</span>
          <a href="/api/user/export" className="hover:text-text transition-colors">Export all data</a>
          <span>·</span>
          <Link href="/privacy" className="hover:text-text transition-colors">Privacy policy</Link>
        </div>
      </div>
    </div>
  );
}

/**
 * First-run screen — shown until the first pipeline run produces data.
 * Replaces the old single empty-state card with the full stepped SetupGuide.
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
        <SetupGuide status={status} />
        <p className="text-center text-[12px] text-text-3 mt-5">
          Want the full picture?{" "}
          <Link href="/dashboard/instructions" className="text-[var(--brand)] hover:underline">
            Read the instructions →
          </Link>
        </p>
      </div>
    </div>
  );
}
