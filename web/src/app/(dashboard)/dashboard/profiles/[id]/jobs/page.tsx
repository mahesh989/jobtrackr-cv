/**
 * Job board — canonical route at /dashboard/profiles/[id]/jobs.
 *
 * Data fetch: three queries + JS stitching.
 *   1. jobs              (filtered by stage / location / posted_within)
 *   2. analysis_runs     (latest non-stale per job — for "Analysed" + tailored CV)
 *   3. cover_letters     (latest non-stale per job — for "Cover letter ready")
 *
 * Progress derivation runs in JS (progressFlags.deriveProgress). At
 * million-user scale, replace with denormalised flags on `jobs` +
 * indexed scan (migration 031 — designed, not built).
 *
 * URL params:
 *   stage        (all|analysed|cvReady|letterReady|applied|dismissed)
 *   triage       (needsJd|roleMismatch|belowThreshold|hasEmail)
 *   sort, dir, location, posted_within, min_keywords, visa_toggle
 *   sort=recently_progressed | most_progressed   (JS-side sort modes)
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { MarkSeenOnLoad } from "@/components/MarkSeenOnLoad";
import { LiveRunStatus } from "@/components/LiveRunStatus";
import { LiveLogConsole } from "@/components/LiveLogConsole";
import { JobTable, type Job } from "@/components/jobs/JobTable";
import { PipelineFunnel, type FunnelCounts } from "@/components/jobs/PipelineFunnel";
import { SmartFilterBar } from "@/components/jobs/SmartFilterBar";
import { ContinueRail, type RailJob } from "@/components/jobs/ContinueRail";
import { JobBoardSettingsPanel } from "@/components/jobs/JobBoardSettings";
import {
  deriveProgress,
  indexLatestByJob,
  type AnalysisRunRef,
  type CoverLetterRef,
} from "@/components/jobs/progressFlags";
import { derivePipelineState } from "@/components/jobs/pipelineState";

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
    .select("id, name, is_active, keywords, schedule_cron")
    .eq("id", id).eq("user_id", user.id).single();
  if (!profile) redirect("/dashboard");

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
  };

  // ── Resolve stage from URL params ─────────────────────────────────────────
  const currentStage = resolveStage(sp);
  const currentTriage = sp.triage || "";

  // ── Build filtered jobs query ────────────────────────────────────────────
  let query = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address, jd_quality, role_match, has_email")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  // Stage-based server-side filtering
  if (currentStage === "applied")        query = query.not("applied_at", "is", null);
  else if (currentStage === "dismissed") query = query.not("dismissed_at", "is", null);
  else                                   query = query.is("dismissed_at", null);

  if (sp.location) query = query.ilike("location", `%${sp.location}%`);

  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      query = query.gte("posted_at", d.toISOString());
    }
  }

  // Server-side sort applies only for the column sort modes. The two
  // progress sorts (recently_progressed, most_progressed) are JS-side
  // because they depend on derived data.
  const sortCol = sp.sort ?? "posted_at";
  const sortDir = sp.dir === "asc";
  const allowed = ["title", "company", "location", "posted_at", "created_at", "visa_likelihood"];
  query = allowed.includes(sortCol)
    ? query.order(sortCol, { ascending: sortDir, nullsFirst: false })
    : query.order("posted_at", { ascending: false, nullsFirst: false });

  query = query.limit(200);
  const { data: jobs } = await query;
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

  // ── Latest non-stale analysis_runs row per job ───────────────────────────
  const { data: recentRuns } = jobIds.length > 0
    ? await supabase
        .from("analysis_runs")
        .select("id, job_id, status, tailored_pdf_storage_path, tailored_cv_storage_path, completed_at, created_at, initial_ats_score, passed_initial_gate, passed_final_gate, automation")
        .in("job_id", jobIds)
        .eq("is_stale", false)
        .order("created_at", { ascending: false })
    : { data: [] as AnalysisRunRef[] };

  // ── Latest non-stale cover_letters row per job ───────────────────────────
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

  // ── Derive progress + pipeline state + attach to each job ────────────────
  let typedJobs: Job[] = jobList.map((j) => {
    const run    = runByJob.get(j.id);
    const letter = letterByJob.get(j.id);
    const progress = deriveProgress(
      { applied_at: j.applied_at },
      run,
      letter,
    );
    const pipelineState = derivePipelineState({
      job: {
        applied_at:   j.applied_at,
        dismissed_at: (j.dismissed_at as string | null) ?? null,
        has_email:    (j.has_email    as boolean | null) ?? null,
        jd_quality:   (j.jd_quality   as string  | null) ?? null,
        role_match:   (j.role_match   as string  | null) ?? null,
      },
      latestRun:    run,
      latestLetter: letter,
    });
    return { ...(j as unknown as Job), progress, pipelineState };
  });

  // ── Funnel counts (computed BEFORE stage/triage filter) ──────────────────
  const funnelCounts: FunnelCounts = {
    discovered:     typedJobs.length,
    analysed:       typedJobs.filter((j) => j.progress.has_analysis).length,
    cvReady:        typedJobs.filter((j) => j.progress.has_tailored_cv).length,
    letterReady:    typedJobs.filter((j) => j.progress.has_cover_letter).length,
    applied:        0, // computed from separate query below
    dismissed:      0, // computed from separate query below
    newCount:       0, // computed from separate query below
    needsJd:        typedJobs.filter((j) => j.jd_quality === "thin").length,
    roleMismatch:   typedJobs.filter((j) => j.role_match === "mismatch").length,
    belowThreshold: typedJobs.filter((j) =>
      j.pipelineState === "below_initial" || j.pipelineState === "below_final"
    ).length,
    hasEmail:       typedJobs.filter((j) => j.has_email === true).length,
    thinJd:         typedJobs.filter((j) => j.jd_quality === "thin").length,
    richJd:         typedJobs.filter((j) => j.jd_quality === "rich").length,
  };

  // ── Continue rail — top 3 by last_progress_at DESC ───────────────────────
  const railJobs: RailJob[] = [...typedJobs]
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

  // ── Stage filter (replaces old chip filter) ──────────────────────────────
  if (currentStage === "analysed") {
    typedJobs = typedJobs.filter((j) => j.progress.has_analysis);
  } else if (currentStage === "cvReady") {
    typedJobs = typedJobs.filter((j) => j.progress.has_tailored_cv);
  } else if (currentStage === "letterReady") {
    typedJobs = typedJobs.filter((j) => j.progress.has_cover_letter);
  }
  // applied + dismissed are handled server-side above

  // ── Triage sub-filter ────────────────────────────────────────────────────
  if (currentTriage === "needsJd" || currentTriage === "thinJd") {
    typedJobs = typedJobs.filter((j) => j.jd_quality === "thin");
  } else if (currentTriage === "richJd") {
    typedJobs = typedJobs.filter((j) => j.jd_quality === "rich");
  } else if (currentTriage === "roleMismatch") {
    typedJobs = typedJobs.filter((j) => j.role_match === "mismatch");
  } else if (currentTriage === "belowThreshold") {
    typedJobs = typedJobs.filter((j) =>
      j.pipelineState === "below_initial" || j.pipelineState === "below_final"
    );
  } else if (currentTriage === "hasEmail") {
    typedJobs = typedJobs.filter((j) => j.has_email === true);
  }

  // ── JS-side sort modes ───────────────────────────────────────────────────
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

  // ── Global counts for funnel (always against unfiltered list) ────────────
  const { data: countRows } = await supabase
    .from("jobs")
    .select("id, seen_at, applied_at, dismissed_at")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  const allRows         = countRows ?? [];
  const newCount        = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;
  const appliedCount    = allRows.filter((j) => j.applied_at).length;
  const dismissedCount  = allRows.filter((j) => j.dismissed_at).length;

  // Patch the counts that need the full unfiltered set
  funnelCounts.applied = appliedCount;
  funnelCounts.dismissed = dismissedCount;
  funnelCounts.newCount = newCount;

  const currentTab = currentStage;

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
              {appliedCount > 0 && (
                <span className="badge badge-green">{appliedCount} applied</span>
              )}
              <span className={`text-[11px] ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                {p.is_active ? "● Auto-scheduled" : "○ Manual"}
              </span>
            </div>
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
            <Link
              href={`/dashboard/profiles/${id}/runs`}
              className="gh-btn text-[12px] px-2.5 py-1"
            >
              Run history
            </Link>
            <Link
              href={`/dashboard/profiles/${id}/edit`}
              className="gh-btn text-[12px] px-2.5 py-1"
            >
              Edit
            </Link>
            <JobBoardSettingsPanel />
            <RunNowButton profileId={id} initialIsRunning={isRunning} />
            <DeleteProfileButton profileId={id} profileName={p.name} compact />
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <LiveRunStatus profileId={id} initialIsRunning={isRunning} />
        <LiveLogConsole profileId={id} />

        {/* Pipeline funnel (replaces StatusTabs + ProgressChips + TriageBanner) */}
        <div className="anim-in">
          <Suspense>
            <PipelineFunnel counts={funnelCounts} currentStage={currentStage} />
          </Suspense>
        </div>

        {/* Smart filter bar (replaces JobFilterBar) */}
        <div className="anim-in">
          <Suspense>
            <SmartFilterBar total={typedJobs.length} />
          </Suspense>
        </div>

        {/* Continue rail — gated by tab + settings */}
        <ContinueRail jobs={railJobs} currentTab={currentTab} />

        {/* Job table */}
        <div className="anim-in anim-delay-1">
          <JobTable
            jobs={typedJobs}
            showVisa={sp.visa_toggle === "1"}
            currentTab={currentTab}
          />
        </div>

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
