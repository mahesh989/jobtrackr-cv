/**
 * Lab job-board route — a sandbox sibling of /dashboard/profiles/[id]/jobs.
 *
 * Mirrors the live page's data fetch but adds:
 *   - cover_letters query (same pattern as analysis_runs)
 *   - progress derivation (progressFlags.deriveProgress) per job
 *   - chip filter (?chips=hasCv,hasLetter,analysed, AND semantics)
 *   - extra sorts (?sort=recently_analysed | most_progressed) applied in JS
 *   - "Continue where you left off" rail (top-3 by last_progress_at)
 *   - <LabSettingsPanel /> mounted in header for live UX toggles
 *
 * Touches NO live files. Promoting to production = fold deltas back into
 * the original page.tsx + JobTable.tsx and delete /lab/.
 *
 * Performance note: this route uses three queries + JS stitching. Fine
 * up to ~hundreds of jobs per user. For million-user scale, replace
 * with denormalised progress flags on `jobs` + a single indexed scan
 * (migration 031 — designed, not built).
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { JobStatusTabs } from "@/components/JobFilters";
import { JobFilterBar } from "@/components/JobFilterBar";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { MarkSeenOnLoad } from "@/components/MarkSeenOnLoad";
import { LiveRunStatus } from "@/components/LiveRunStatus";
import { LiveLogConsole } from "@/components/LiveLogConsole";
import { LabJobTable, type LabJob } from "@/components/jobs/lab/LabJobTable";
import { LabFilterChips, type LabFilterChipCounts } from "@/components/jobs/lab/LabFilterChips";
import { ContinueRail, type RailJob } from "@/components/jobs/lab/ContinueRail";
import { LabSettingsPanel } from "@/components/jobs/lab/LabSettingsPanel";
import {
  deriveProgress,
  indexLatestByJob,
  type AnalysisRunRef,
  type CoverLetterRef,
} from "@/components/jobs/lab/progressFlags";

interface SearchParams {
  sort?:          string;
  dir?:           string;
  status?:        string;
  min_keywords?:  string;
  min_visa?:      string;
  visa_toggle?:   string;
  source?:        string;
  location?:      string;
  posted_within?: string;
  chips?:         string;
}

type ChipKey = "analysed" | "hasCv" | "hasLetter";
const VALID_CHIPS: ChipKey[] = ["analysed", "hasCv", "hasLetter"];

function parseChips(raw: string | undefined): Set<ChipKey> {
  if (!raw) return new Set();
  const valid = new Set<ChipKey>(VALID_CHIPS);
  return new Set(
    raw.split(",").map((s) => s.trim()).filter((s): s is ChipKey => valid.has(s as ChipKey)),
  );
}

export default async function LabJobsPage({
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

  // ── Build filtered query (mirrors profiles/[id]/jobs/page.tsx) ───────────
  let query = supabase
    .from("jobs")
    .select("id, profile_id, url, title, company, location, description, source, source_tier, posted_at, created_at, visa_likelihood, sponsorship_status, citizen_pr_only, visa_extracted_text, keywords_matched, applied_at, dismissed_at, is_dead_link, seen_at, is_expired, dedup_status, manual_jd_text, contact_email, hiring_manager, company_address")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  if (sp.status === "new")            query = query.is("seen_at", null).is("dismissed_at", null);
  else if (sp.status === "applied")   query = query.not("applied_at", "is", null).is("dismissed_at", null);
  else if (sp.status === "dismissed") query = query.not("dismissed_at", "is", null);
  else                                query = query.is("dismissed_at", null);

  if (sp.location) query = query.ilike("location", `%${sp.location}%`);

  if (sp.posted_within && sp.posted_within !== "any") {
    const days = parseInt(sp.posted_within, 10);
    if (!isNaN(days)) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      query = query.gte("posted_at", d.toISOString());
    }
  }

  // Server-side sort only for the original column set. The lab's two new
  // sort modes (`recently_analysed`, `most_progressed`) are JS-side because
  // they depend on derived progress data we haven't joined yet.
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
        .select("id, job_id, status, tailored_pdf_storage_path, tailored_cv_storage_path, completed_at, created_at")
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

  // ── Derive progress + attach to each job ─────────────────────────────────
  let labJobs: LabJob[] = jobList.map((j) => {
    const progress = deriveProgress(
      { applied_at: j.applied_at },
      runByJob.get(j.id),
      letterByJob.get(j.id),
    );
    return { ...(j as unknown as LabJob), progress };
  });

  // ── Chip filter (AND semantics) ──────────────────────────────────────────
  const selectedChips = parseChips(sp.chips);
  if (selectedChips.size > 0) {
    labJobs = labJobs.filter((j) => {
      if (selectedChips.has("analysed")  && !j.progress.has_analysis)     return false;
      if (selectedChips.has("hasCv")     && !j.progress.has_tailored_cv)  return false;
      if (selectedChips.has("hasLetter") && !j.progress.has_cover_letter) return false;
      return true;
    });
  }

  // ── Lab-specific sort modes (JS-side) ────────────────────────────────────
  if (sortCol === "recently_analysed") {
    labJobs = [...labJobs].sort((a, b) => {
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return sortDir ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  } else if (sortCol === "most_progressed") {
    labJobs = [...labJobs].sort((a, b) => {
      const ds = b.progress.progress_score - a.progress.progress_score;
      if (ds !== 0) return sortDir ? -ds : ds;
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return sortDir ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  }

  // ── Chip counts (AGAINST current jobList before chip filtering) ──────────
  // Counts reflect "how many jobs in your current view would match if I
  // toggled this chip on". For UX honesty we count against the pre-chip
  // list so the numbers don't go to 0 when you select a chip.
  const preChip: LabJob[] = jobList.map((j) => {
    const progress = deriveProgress(
      { applied_at: j.applied_at },
      runByJob.get(j.id),
      letterByJob.get(j.id),
    );
    return { ...(j as unknown as LabJob), progress };
  });
  const chipCounts: LabFilterChipCounts = {
    analysed:  preChip.filter((j) => j.progress.has_analysis).length,
    hasCv:     preChip.filter((j) => j.progress.has_tailored_cv).length,
    hasLetter: preChip.filter((j) => j.progress.has_cover_letter).length,
  };

  // ── Continue rail — top 3 by last_progress_at DESC ───────────────────────
  const railJobs: RailJob[] = [...preChip]
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

  // ── Status-tab counts (always against unfiltered active list) ────────────
  const { data: countRows } = await supabase
    .from("jobs")
    .select("id, seen_at, applied_at, dismissed_at")
    .eq("profile_id", id)
    .eq("is_expired", false)
    .eq("is_dead_link", false);

  const allRows         = countRows ?? [];
  const totalCount      = allRows.filter((j) => !j.dismissed_at).length;
  const newCount        = allRows.filter((j) => !j.seen_at && !j.dismissed_at).length;
  const appliedCount    = allRows.filter((j) => j.applied_at).length;
  const dismissedCount  = allRows.filter((j) => j.dismissed_at).length;

  const currentTab = sp.status ?? "all";

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
              <Link href={`/dashboard/profiles/${id}/jobs`} className="hover:text-text transition-colors truncate max-w-[200px]">
                {p.name}
              </Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text font-medium">Beta board</span>
            </div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-[16px] font-semibold text-text flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-[var(--brand)]" />
                {p.name}
                <span className="text-[10px] font-bold px-1.5 h-4 rounded badge badge-purple">BETA</span>
              </h1>
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

          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/dashboard/profiles/${id}/jobs`}
              className="gh-btn text-[12px] px-2.5 py-1"
              title="Switch back to the original job board"
            >
              ← Classic view
            </Link>
            <LabSettingsPanel />
            <RunNowButton profileId={id} initialIsRunning={isRunning} />
            <DeleteProfileButton profileId={id} profileName={p.name} compact />
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <LiveRunStatus profileId={id} initialIsRunning={isRunning} />
        <LiveLogConsole profileId={id} />

        {/* Status tabs (reused) */}
        <div className="anim-in">
          <Suspense>
            <JobStatusTabs
              totalCount={totalCount}
              newCount={newCount}
              appliedCount={appliedCount}
              dismissedCount={dismissedCount}
            />
          </Suspense>
        </div>

        {/* Standard filter bar (reused) */}
        <div className="anim-in">
          <Suspense>
            <JobFilterBar total={labJobs.length} />
          </Suspense>
        </div>

        {/* Lab progress chips + extra sort */}
        <div className="anim-in anim-delay-1">
          <Suspense>
            <LabFilterChips counts={chipCounts} />
          </Suspense>
        </div>

        {/* Continue rail — top of board, gated by tab + settings */}
        <ContinueRail jobs={railJobs} currentTab={currentTab} />

        {/* Job table */}
        <div className="anim-in anim-delay-1">
          <LabJobTable
            jobs={labJobs}
            showVisa={sp.visa_toggle === "1"}
            currentTab={currentTab}
          />
        </div>

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
          <span>·</span>
          <Link href={`/dashboard/profiles/${id}/jobs`} className="hover:text-text transition-colors">
            Classic view
          </Link>
        </div>
      </div>
    </div>
  );
}
