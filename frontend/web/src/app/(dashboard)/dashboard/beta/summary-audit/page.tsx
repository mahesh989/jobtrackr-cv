/**
 * /dashboard/beta/summary-audit
 *
 * Founder-only. Downloads all recent tailored CVs, extracts the Career
 * Highlights section from each, and shows them side-by-side with the JD's
 * top responsibilities. Flags summaries that are too similar to each other.
 * "Copy all" exports a paste-ready report for iterating with Claude.
 */
import { redirect }          from "next/navigation";
import Link                  from "next/link";
import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import SummaryAuditClient    from "./SummaryAuditClient";
import { MANUAL_JD_MIN_CHARS } from "@/components/jobs/jobFilters";

export const dynamic    = "force-dynamic";
export const maxDuration = 120;

export interface SummaryRow {
  run_id:              string;
  job_id:              string;
  job_title:           string;
  company:             string;
  role_family:         string;
  jd_summary:          string;
  jd_responsibilities: string[];
  career_highlights:   string;   // extracted prose from tailored CV
  created_at:          string;
}

export interface FullJdJob {
  job_id:    string;
  job_title: string;
  company:   string;
}

const STORAGE_BUCKET = "tailored-cvs";
const HIGHLIGHT_HEADINGS = new Set([
  "career highlights", "professional summary", "summary", "profile",
]);

function extractCareerHighlights(md: string): string {
  const lines = md.split("\n");
  let inSection = false;
  const prose: string[] = [];

  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith("## ") && HIGHLIGHT_HEADINGS.has(s.slice(3).trim().toLowerCase())) {
      inSection = true;
      continue;
    }
    if (inSection && s.startsWith("## ")) break;
    if (inSection && s && !s.match(/^[-*•]/)) {
      prose.push(s);
    }
  }
  return prose.join(" ").trim();
}

export default async function SummaryAuditPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard");

  const admin = createAdminClient();

  // ── Full-JD jobs for re-analyse button ──────────────────────────────────
  const { data: profileRows } = await admin
    .from("search_profiles")
    .select("id")
    .eq("user_id", user.id);
  const profileIds = (profileRows ?? []).map((p) => p.id as string);

  const fullJdJobs: FullJdJob[] = [];
  if (profileIds.length > 0) {
    const { data: allJobs } = await admin
      .from("jobs")
      .select("id, title, company, jd_quality, manual_jd_text")
      .in("profile_id", profileIds)
      .or("jd_quality.neq.thin,manual_jd_text.not.is.null")
      .order("created_at", { ascending: false })
      .limit(500);

    for (const j of allJobs ?? []) {
      const hasManual = !!(j.manual_jd_text && (j.manual_jd_text as string).trim().length >= MANUAL_JD_MIN_CHARS);
      if (hasManual || (j.jd_quality && j.jd_quality !== "thin")) {
        fullJdJobs.push({
          job_id:    j.id as string,
          job_title: (j.title   as string) ?? "",
          company:   (j.company as string) ?? "",
        });
      }
    }
  }

  // ── Fetch analysis runs ──────────────────────────────────────────────────
  const _RUN_COLS = "id, job_id, tailored_cv_storage_path, jd_analysis_result, created_at";

  let { data: runs } = await admin
    .from("analysis_runs")
    .select(_RUN_COLS)
    .not("tailored_cv_storage_path", "is", null)
    .or("is_stale.is.null,is_stale.eq.false")
    .order("created_at", { ascending: false })
    .limit(200);

  if (!runs || runs.length === 0) {
    const { data: staleRuns } = await admin
      .from("analysis_runs")
      .select(_RUN_COLS)
      .not("tailored_cv_storage_path", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);
    runs = staleRuns;
  }

  // ── Fetch job metadata ───────────────────────────────────────────────────
  const jobIds = [...new Set((runs ?? []).map((r) => r.job_id as string).filter(Boolean))];
  const { data: jobsRaw } = await admin
    .from("jobs")
    .select("id, title, company")
    .in("id", jobIds);
  const jobMap = new Map((jobsRaw ?? []).map((j) => [j.id as string, j]));

  // ── Deduplicate to one run per job ───────────────────────────────────────
  const seenJobs = new Set<string>();
  const dedupedRuns: typeof runs = [];
  for (const run of runs ?? []) {
    const jid = run.job_id as string;
    if (!jid || seenJobs.has(jid)) continue;
    seenJobs.add(jid);
    dedupedRuns.push(run);
  }

  // ── Download tailored CVs ────────────────────────────────────────────────
  const mdResults = await Promise.all(
    dedupedRuns.map(async (run) => {
      try {
        const { data, error } = await admin.storage
          .from(STORAGE_BUCKET)
          .download(run.tailored_cv_storage_path as string);
        if (error || !data) return "";
        return await data.text();
      } catch { return ""; }
    })
  );

  // ── Build rows ───────────────────────────────────────────────────────────
  const rows: SummaryRow[] = dedupedRuns
    .map((run, i) => {
      const jid        = run.job_id as string;
      const tailored   = mdResults[i] ?? "";
      const jdAnalysis = (run.jd_analysis_result as Record<string, unknown> | null) ?? {};
      const job        = jobMap.get(jid);

      const highlights = extractCareerHighlights(tailored);
      if (!highlights) return null;

      return {
        run_id:              run.id as string,
        job_id:              jid,
        job_title:           (job?.title   as string) ?? (jdAnalysis.job_title as string) ?? "",
        company:             (job?.company as string) ?? "",
        role_family:         (jdAnalysis.role_family as string) ?? "master",
        jd_summary:          (jdAnalysis.summary as string) ?? "",
        jd_responsibilities: (jdAnalysis.responsibilities as string[]) ?? [],
        career_highlights:   highlights,
        created_at:          run.created_at as string,
      };
    })
    .filter((r): r is SummaryRow => r !== null);

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <Link href="/dashboard/beta" className="hover:text-text transition-colors">Beta</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-text-2">Summary Audit</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Summary Audit — Career Highlights quality</h1>
        <p className="text-[12px] text-text-2 mt-1 max-w-2xl">
          Extracts Career Highlights from every recent tailored CV. Shows each summary alongside
          the JD&apos;s top responsibilities so you can verify they&apos;re distinctly tailored.
          Flags summaries that share too many tokens with others in the same role family.
          Copy all to paste directly to Claude for prompt iteration.
        </p>
      </div>

      <div className="px-6 py-5">
        <SummaryAuditClient rows={rows} fullJdJobs={fullJdJobs} />
      </div>
    </div>
  );
}
