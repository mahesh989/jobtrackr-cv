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
import { redirect } from "next/navigation";
import { MIN_INITIAL_ATS, MIN_FINAL_ATS } from "@/lib/atsThresholds";
import { Suspense } from "react";
import Link from "next/link";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { MarkSeenOnLoad } from "@/components/MarkSeenOnLoad";
import { LiveRunStatus } from "@/components/LiveRunStatus";
import { LiveLogConsole } from "@/components/LiveLogConsole";
import { type Job } from "@/components/jobs/JobTable";
import { type FunnelCounts } from "@/components/jobs/PipelineFunnel";
import { type RailJob } from "@/components/jobs/ContinueRail";
import { JobBoardSettingsPanel } from "@/components/jobs/JobBoardSettings";
import { ProfileJobBoard } from "@/components/jobs/ProfileJobBoard";
import { atsBandFor, type BoardJob } from "@/components/jobs/jobFilters";
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, keywords, schedule_cron, home_address")
    .eq("id", id).eq("user_id", user.id).single();
  if (!profile) redirect("/dashboard");

  const th = { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };

  const { data: activeRun } = await supabase
    .from("run_logs")
    .select("id")
    .eq("profile_id", id)
    .eq("status", "running")
    .maybeSingle();
  const isRunning = !!activeRun;

  const p = profile as {
    id: string; name: string; is_active: boolean;
    keywords: string[]; schedule_cron: string;
    home_address: string | null;
  };

  // ── Determine whether we're showing dismissed jobs ───────────────────────
  // Dismissed is the only dataset filter for stage — it changes which rows
  // are fetched so it stays server-side. Everything else (analysed, cvReady,
  // letterReady, thinJd) is a view filter applied client-side.
  const isDismissedView = sp.stage === "dismissed" || sp.status === "dismissed";

  // ── Build job query ──────────────────────────────────────────────────────
  let query = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email, distance_km, distance_method")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  if (isDismissedView) query = query.not("dismissed_at", "is", null);
  else                 query = query.is("dismissed_at", null);

  if (sp.location)      query = query.ilike("location", `%${sp.location}%`);
  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      query = query.gte("posted_at", d.toISOString());
    }
  }

  // Default server sort so the initial paint is in a sensible order.
  // Client-side re-sorts happen instantly after hydration.
  query = query.order("posted_at", { ascending: false, nullsFirst: false }).limit(200);

  const { data: jobs } = await query;
  const jobList = (jobs ?? []) as Array<{ id: string; profile_id: string; applied_at: string | null; [k: string]: unknown }>;

  const jobIds = jobList.map((j) => j.id);

  // ── Latest non-stale analysis_runs + cover_letters ───────────────────────
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
      liveRun?.passed_initial_gate ?? null,
      liveRun?.passed_final_gate   ?? null,
    );
    return { ...(j as unknown as Job), progress, pipelineState, atsBand };
  });

  // ── Continue rail — top 3 most recently progressed ───────────────────────
  const railJobs: RailJob[] = [...boardJobs]
    .filter((j) => j.progress.last_progress_at !== null && !j.dismissed_at)
    .sort((a, b) =>
      (b.progress.last_progress_at ?? "").localeCompare(a.progress.last_progress_at ?? ""),
    )
    .slice(0, 3)
    .map((j) => ({
      id:         j.id,
      profile_id: j.profile_id,
      title:      j.title,
      company:    j.company,
      progress:   j.progress,
    }));

  // ── Global counts for funnel ─────────────────────────────────────────────
  const { data: countRows } = await supabase
    .from("jobs")
    .select("id, seen_at, applied_at, dismissed_at, profile_id, jd_quality, role_match, has_email")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  interface AllCountRow {
    id: string; seen_at: string | null; applied_at: string | null;
    dismissed_at: string | null; profile_id: string;
    jd_quality: string | null; role_match: string | null; has_email: boolean | null;
  }
  const allRows = (countRows ?? []) as AllCountRow[];
  const jobIdsForCounts = allRows.map((r) => r.id);

  const [runsRes, lettersRes] = jobIdsForCounts.length > 0
    ? await Promise.all([
        supabase
          .from("analysis_runs")
          .select("job_id, tailored_cv_storage_path, tailored_pdf_storage_path, initial_ats_score, tailored_match_score, passed_initial_gate, passed_final_gate")
          .eq("is_stale", false).eq("status", "completed")
          .in("job_id", jobIdsForCounts),
        supabase
          .from("cover_letters")
          .select("job_id")
          .eq("is_stale", false).eq("status", "completed")
          .in("job_id", jobIdsForCounts),
      ])
    : [{ data: [] }, { data: [] }];

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
  const tabAppliedCount = allRows.filter((j) => j.applied_at).length;
  const tabDismissedCount = allRows.filter((j) => j.dismissed_at).length;
  const newCount        = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;

  const funnelCounts: FunnelCounts = {
    discovered:     tabTotalCount,
    analysed:       allRows.filter((j) => !j.dismissed_at && analysedSet.has(j.id)).length,
    cvReady:        allRows.filter((j) => !j.dismissed_at && cvReadySet.has(j.id)).length,
    letterReady:    allRows.filter((j) => !j.dismissed_at && letterReadySet.has(j.id)).length,
    applied:        tabAppliedCount,
    dismissed:      tabDismissedCount,
    newCount,
    needsJd:        allRows.filter((j) => !j.dismissed_at && j.jd_quality === "thin").length,
    roleMismatch:   allRows.filter((j) => !j.dismissed_at && j.role_match === "mismatch").length,
    belowThreshold: allRows.filter((j) => !j.dismissed_at && belowThresholdSet.has(j.id)).length,
    hasEmail:       allRows.filter((j) => !j.dismissed_at && j.has_email === true).length,
    thinJd:         allRows.filter((j) => !j.dismissed_at && j.jd_quality === "thin").length,
    richJd:         allRows.filter((j) => !j.dismissed_at && j.jd_quality === "rich").length,
  };

  const exportParams = new URLSearchParams();
  if (sp.sort) exportParams.set("sort", sp.sort);
  if (sp.min_keywords) exportParams.set("min_keywords", sp.min_keywords);
  if (sp.min_visa) exportParams.set("min_visa", sp.min_visa);

  return (
    <div className="min-h-full">
      <MarkSeenOnLoad profileId={id} />

      {/* Header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Profiles</span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text font-medium truncate max-w-[200px]">{p.name}</span>
            </div>
            <div className="flex items-center gap-2.5">
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

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/api/profiles/${id}/jobs/export?${exportParams.toString()}`}
              className="gh-btn text-[12px] px-2.5 py-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Export CSV
            </Link>
            <Link href={`/dashboard/profiles/${id}/runs`} className="gh-btn text-[12px] px-2.5 py-1">
              Run history
            </Link>
            <Link href={`/dashboard/profiles/${id}/edit`} className="gh-btn text-[12px] px-2.5 py-1">
              Edit
            </Link>
            <JobBoardSettingsPanel />
            <RunNowButton profileId={id} initialIsRunning={isRunning} />
            <DeleteProfileButton profileId={id} profileName={p.name} compact />
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
       <div className="max-w-5xl mx-auto space-y-4">
        <LiveRunStatus profileId={id} initialIsRunning={isRunning} />
        <LiveLogConsole profileId={id} />

        {/* Client-side board — instant stage/triage/sort/keyword filtering */}
        <Suspense>
          <ProfileJobBoard
            jobs={boardJobs}
            counts={funnelCounts}
            railJobs={railJobs}
            homeAddress={p.home_address}
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
    </div>
  );
}
