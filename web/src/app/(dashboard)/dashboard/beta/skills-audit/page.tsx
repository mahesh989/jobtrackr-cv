/**
 * /dashboard/beta/skills-audit
 *
 * Founder-only. Query recent analysis_runs, download tailored CVs from storage,
 * parse Skills sections, classify every Other Skills item via
 * /api/internal/classify-skills. Shows a table of jobs with action-needed items
 * highlighted. Re-analyse and export buttons in the client component.
 *
 * All Supabase queries + storage downloads run server-side (SSR).
 * Classification and re-analysis happen client-side.
 */
import { redirect }          from "next/navigation";
import Link                  from "next/link";
import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import SkillsAuditClient     from "./SkillsAuditClient";

export const dynamic = "force-dynamic";

// Next.js default server-action timeout is 60 s; storage downloads can be slow
// for 20 concurrent files — raise to 120 s.
export const maxDuration = 120;

export interface RunRow {
  run_id:       string;
  job_id:       string;
  job_title:    string;
  company:      string;
  role_family:  string;
  lex_vertical: string | null;
  jd_quality:   string | null;
  jd_length:    number;
  other_items:  string[];
  all_labels:   Record<string, string[]>;
}

const VERT_MAP: Record<string, string> = {
  nursing: "nursing",
  tech:    "tech",
  manual:  "cleaning",
};

const STORAGE_BUCKET = "tailored-cvs";

function extractSkills(md: string): Record<string, string[]> {
  const lines    = md.split("\n");
  let inSkills   = false;
  const result: Record<string, string[]> = {};
  const labelRe  = /^\s*(?:[-*•]\s+)?\*\*([^*]+?):\*\*\s*(.*)/;

  for (const line of lines) {
    const s = line.trim();
    if (s.toLowerCase() === "## skills") { inSkills = true; continue; }
    if (inSkills && s.startsWith("## ")) break;
    if (inSkills) {
      const m = labelRe.exec(line);
      if (m) {
        const label = m[1].trim();
        const items = m[2].split(",").map((x) => x.trim()).filter(Boolean);
        result[label] = items;
      }
    }
  }
  return result;
}

export default async function SkillsAuditPage() {
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

  // ── 1. Fetch recent runs that have a tailored CV in storage ───────────────
  const { data: runs } = await admin
    .from("analysis_runs")
    .select("id, job_id, tailored_cv_storage_path, jd_analysis_result, created_at")
    .not("tailored_cv_storage_path", "is", null)
    .or("is_stale.is.null,is_stale.eq.false")
    .order("created_at", { ascending: false })
    .limit(200);

  // ── 2. Fetch job metadata ─────────────────────────────────────────────────
  const jobIds = [...new Set((runs ?? []).map((r) => r.job_id as string).filter(Boolean))];
  const { data: jobsRaw } = await admin
    .from("jobs")
    .select("id, title, company, jd_quality, description, manual_jd_text")
    .in("id", jobIds);

  const jobMap = new Map((jobsRaw ?? []).map((j) => [j.id as string, j]));

  // ── 3. Deduplicate to one run per job (most recent) ───────────────────────
  const seenJobs = new Set<string>();
  const dedupedRuns: typeof runs = [];
  for (const run of runs ?? []) {
    const jid = run.job_id as string;
    if (!jid || seenJobs.has(jid)) continue;
    seenJobs.add(jid);
    dedupedRuns.push(run);
  }

  // ── 4. Download tailored CVs from storage in parallel ────────────────────
  const mdResults = await Promise.all(
    dedupedRuns.map(async (run) => {
      const path = run.tailored_cv_storage_path as string;
      try {
        const { data, error } = await admin.storage
          .from(STORAGE_BUCKET)
          .download(path);
        if (error || !data) return "";
        return await data.text();
      } catch {
        return "";
      }
    })
  );

  // ── 5. Build rows ─────────────────────────────────────────────────────────
  const rows: RunRow[] = dedupedRuns.map((run, i) => {
    const jid        = run.job_id as string;
    const tailored   = mdResults[i] ?? "";
    const jdAnalysis = (run.jd_analysis_result as Record<string, string> | null) ?? {};
    const roleFamily = jdAnalysis.role_family ?? "master";
    const lexVertical = VERT_MAP[roleFamily] ?? null;

    const allLabels  = extractSkills(tailored);
    const otherKey   = Object.keys(allLabels).find(
      (k) => k.toLowerCase().includes("other") || k.toLowerCase().includes("technical")
    );
    const otherItems = otherKey ? allLabels[otherKey] : [];

    const job       = jobMap.get(jid);
    const manualLen = ((job?.manual_jd_text as string) ?? "").trim().length;
    const descLen   = ((job?.description   as string) ?? "").trim().length;

    return {
      run_id:       run.id as string,
      job_id:       jid,
      job_title:    (job?.title       as string) ?? "",
      company:      (job?.company     as string) ?? "",
      role_family:  roleFamily,
      lex_vertical: lexVertical,
      jd_quality:   (job?.jd_quality  as string | null) ?? null,
      jd_length:    Math.max(manualLen, descLen),
      other_items:  otherItems,
      all_labels:   allLabels,
    };
  });

  const totalRuns = (runs ?? []).length;

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
          <span className="text-text-2">Skills Audit</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Skills Audit — Other Skills classifier</h1>
        <p className="text-[12px] text-text-2 mt-1 max-w-2xl">
          Downloads every recent tailored CV from storage, extracts Other Skills items, and classifies
          each via the deterministic lexicon. Re-analyse buttons kick off fresh pipeline runs using
          the updated lexicon. Export for pasting to Claude for further improvements. No AI calls on load.
        </p>
      </div>

      <div className="px-6 py-5">
        <SkillsAuditClient rows={rows} totalRuns={totalRuns} />
      </div>
    </div>
  );
}
