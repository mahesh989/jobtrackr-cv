/**
 * Per-profile job board — /dashboard/profiles/[id]/jobs.
 *
 * Server responsibilities (unchanged after refactor):
 *   1. Auth + profile ownership check.
 *   2. Fetch the capped (≤200) non-dismissed job set, filtered by:
 *        location, posted_within   ← dataset filters (change which rows arrive)
 *      Applied / dismissed switch still goes through the server too.
 *   3. Fetch analysis_runs + cover_letters to derive progress/pipeline state.
 *   4. Compute funnelCounts from a separate lightweight query.
 *   5. Attach atsBand to each job (needed for the shared filterJobs helper).
 *
 * Everything else (stage / triage / sort / keywords) is now handled
 * client-side in ProfileJobBoard — clicking a funnel tab is instant.
 */

import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/getUser";
import { redirect } from "next/navigation";
import { resolveThresholds } from "@/lib/atsThresholds";
import { Suspense } from "react";
import Link from "next/link";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { MarkSeenOnLoad } from "@/components/MarkSeenOnLoad";
import { LiveRunStatus } from "@/components/LiveRunStatus";
import { LiveLogConsole } from "@/components/LiveLogConsole";
import { type FunnelCounts } from "@/components/jobs/PipelineFunnel";
import { ProfileJobBoard } from "@/components/jobs/ProfileJobBoard";
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
  /** @deprecated — kept for backward compat with old bookmarks */
  status?:        string;
  /** @deprecated — kept for backward compat with old bookmarks */
  chips?:         string;
  min_keywords?:  string;
  min_visa?:      string;
  visa_toggle?:   string;
  source?:        string;
  location?:      string;
  posted_within?: string;
}

export default async function JobsPage({
  params,
  searchParams,
}: {
  params:       Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp     = await searchParams;

  const supabase = await createClient();
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, is_manual, keywords, schedule_cron, home_address, target_verticals")
    .eq("id", id).eq("user_id", user.id).single();
  if (!profile) redirect("/dashboard");

  // Per-vertical cutoffs (healthcare/nursing = 55/65). Drives live re-bucketing
  // so the ATS tabs/counts match the gate the analysis actually used.
  const th = resolveThresholds(
    (profile as { target_verticals?: string[] | null }).target_verticals,
  );

  const p = profile as {
    id: string; name: string; is_active: boolean; is_manual: boolean;
    keywords: string[]; schedule_cron: string;
    home_address: string | null;
  };

  interface AllCountRow {
    id: string; seen_at: string | null; applied_at: string | null;
    dismissed_at: string | null; profile_id: string; starred_at: string | null;
    jd_quality: string | null; manual_jd_text: string | null;
    role_match: string | null; has_email: boolean | null;
  }

  const isDismissedView = sp.stage === "dismissed" || sp.status === "dismissed";

  let query = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, starred_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email, distance_km, distance_method")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);
  if (isDismissedView) query = query.not("dismissed_at", "is", null);
  else                 query = query.is("dismissed_at", null);
  if (sp.location) query = query.ilike("location", `%${sp.location}%`);
  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      query = query.gte("posted_at", d.toISOString());
    }
  }
  query = query.order("posted_at", { ascending: false, nullsFirst: false }).limit(200);

  // ── BATCH 1 — three parallel queries (all need only profile `id`) ─────────
  const [
    { data: jobs },
    { data: countRows },
    { data: activeRunData },
  ] = await Promise.all([
    query,
    supabase
      .from("jobs")
      .select("id, seen_at, applied_at, dismissed_at, starred_at, profile_id, jd_quality, manual_jd_text, role_match, has_email")
      .eq("profile_id", id)
      .eq("is_expired", false)
      .eq("is_dead_link", false),
    supabase.from("run_logs").select("id").eq("profile_id", id).eq("status", "running").maybeSingle(),
  ]);

  const isRunning     = !!activeRunData;
  const jobList       = (jobs ?? []) as Array<{ id: string; profile_id: string; applied_at: string | null; [k: string]: unknown }>;
  const jobIds        = jobList.map((j) => j.id);
  const allRows       = (countRows ?? []) as AllCountRow[];
  const jobIdsForCounts = allRows.map((r) => r.id);

  // ── BATCH 2 — four parallel queries (need job IDs from BATCH 1) ───────────
  const [
    { data: recentRuns },
    { data: recentLetters },
    runsRes,
    lettersRes,
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
  ]);

  const runByJob    = indexLatestByJob((recentRuns    ?? []) as AnalysisRunRef[]);
  const letterByJob = indexLatestByJob((recentLetters ?? []) as CoverLetterRef[]);

  // ── Derive progress + pipeline state + ATS band ──────────────────────────
  const boardJobs: BoardJob[] = jobList.map((j) => {
    const run    = runByJob.get(j.id);
    const letter = letterByJob.get(j.id);
    const progress = deriveProgress({ applied_at: j.applied_at }, run, letter);
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
    const atsBand = atsBandFor(
      !!run,
      run?.initial_ats_score ?? null,
      run?.tailored_match_score ?? null,
      th.initial,
      th.final
    );
    return {
      ...(j as unknown as BoardJob),
      progress,
      pipelineState,
      atsBand,
      atsThresholds:        th,
      initial_ats_score:    run?.initial_ats_score    ?? null,
      tailored_match_score: run?.tailored_match_score ?? null,
    };
  });

  // (allRows, runsRes, lettersRes fetched in BATCH 1 and BATCH 2 above)

  const analysedSet    = new Set((runsRes.data ?? []).map((r) => r.job_id));
  const cvReadySet     = new Set((runsRes.data ?? []).filter((r) => r.tailored_cv_storage_path || r.tailored_pdf_storage_path).map((r) => r.job_id));
  const letterReadySet = new Set((lettersRes.data ?? []).map((l) => l.job_id));
  const belowThresholdSet = new Set(
    (runsRes.data ?? [])
      .filter((r) => {
        const g = recomputeGates(
          (r as { initial_ats_score?: number | null }).initial_ats_score,
          (r as { tailored_match_score?: number | null }).tailored_match_score,
          th.initial, th.final,
        );
        return g.passedInitial === false || g.passedFinal === false;
      })
      .map((r) => r.job_id),
  );

  const tabTotalCount   = allRows.filter((j) => !j.dismissed_at).length;
  const tabAppliedCount = allRows.filter((j) => j.applied_at && !j.dismissed_at).length;
  const tabDismissedCount = allRows.filter((j) => j.dismissed_at).length;
  const newCount        = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;

  const funnelCounts: FunnelCounts = {
    discovered:     tabTotalCount,
    analysed:       allRows.filter((j) => !j.dismissed_at && analysedSet.has(j.id)).length,
    cvReady:        allRows.filter((j) => !j.dismissed_at && cvReadySet.has(j.id)).length,
    letterReady:    allRows.filter((j) => !j.dismissed_at && letterReadySet.has(j.id)).length,
    applied:        tabAppliedCount,
    dismissed:      tabDismissedCount,
    favourite:      allRows.filter((j) => j.starred_at && !j.dismissed_at).length,
    newCount,
    needsJd:        allRows.filter((j) => !j.dismissed_at && jobNeedsJd(j)).length,
    roleMismatch:   allRows.filter((j) => !j.dismissed_at && j.role_match === "mismatch").length,
    belowThreshold: allRows.filter((j) => !j.dismissed_at && belowThresholdSet.has(j.id)).length,
    hasEmail:       allRows.filter((j) => !j.dismissed_at && j.has_email === true).length,
    thinJd:         allRows.filter((j) => !j.dismissed_at && jobNeedsJd(j)).length,
    richJd:         allRows.filter((j) => !j.dismissed_at && (j.jd_quality === "rich" || (j.jd_quality === "thin" && !jobNeedsJd(j)))).length,
  };

  const exportParams = new URLSearchParams();
  if (sp.sort) exportParams.set("sort", sp.sort);
  if (sp.min_keywords) exportParams.set("min_keywords", sp.min_keywords);
  if (sp.min_visa) exportParams.set("min_visa", sp.min_visa);

  return (
    <div className="min-h-full">
      <MarkSeenOnLoad profileId={id} />

      {/* Header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-2">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <Link href="/dashboard/profiles" className="hover:text-text transition-colors">Job Searches</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text font-medium truncate max-w-[160px]">{p.name}</span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-[16px] font-semibold text-text">{p.name}</h1>
              {newCount > 0 && (
                <span className="badge badge-blue font-bold">{newCount} new</span>
              )}
              {tabAppliedCount > 0 && (
                <span className="badge badge-green">{tabAppliedCount} applied</span>
              )}
              <span className={`text-[11px] ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                {p.is_active ? "● Auto-scheduled" : "○ Manual"}
              </span>
            </div>
            {p.home_address && (
              <p className="text-[12px] text-text-2 flex items-center gap-1.5 mt-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
                {p.home_address}
              </p>
            )}
          </div>

          {/* Actions — wrap on mobile */}
          <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0">
            <Link
              href={`/api/profiles/${id}/jobs/export?${exportParams.toString()}`}
              className="gh-btn text-[12px] px-2.5 py-1 shrink-0 whitespace-nowrap"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Export CSV
            </Link>
            <Link href={`/dashboard/profiles/${id}/runs`} className="gh-btn text-[12px] px-2.5 py-1 shrink-0 whitespace-nowrap">
              Run history
            </Link>
            <Link href={`/dashboard/profiles/${id}/edit`} className="gh-btn text-[12px] px-2.5 py-1 shrink-0 whitespace-nowrap">
              Edit
            </Link>
            <RunNowButton profileId={id} initialIsRunning={isRunning} />
            <DeleteProfileButton profileId={id} profileName={p.name} compact />
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <LiveRunStatus profileId={id} initialIsRunning={isRunning} />
        <LiveLogConsole profileId={id} />

        {/* Client-side board — instant stage/triage/sort/keyword filtering */}
        <Suspense>
          <ProfileJobBoard
            jobs={boardJobs}
            counts={funnelCounts}
            homeAddress={p.home_address}
            thresholds={th}
            isManual={p.is_manual ?? false}
          />
        </Suspense>

        {/* Footer */}
        <div className="flex items-center gap-3 text-[11px] text-text-3 pt-2 anim-in anim-delay-2">
          <Link href={`/dashboard/profiles/${id}/runs`} className="hover:text-text transition-colors">
            Run history
          </Link>
          <span>·</span>
          <Link href={`/api/profiles/${id}/jobs/export`} className="hover:text-text transition-colors">
            Export all as CSV
          </Link>
          <span>·</span>
          <Link href={`/dashboard/profiles/${id}/edit`} className="hover:text-text transition-colors">
            Edit profile
          </Link>
        </div>
      </div>
    </div>
  );
}
