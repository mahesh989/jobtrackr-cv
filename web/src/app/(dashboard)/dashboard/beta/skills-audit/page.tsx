/**
 * /dashboard/beta/skills-audit
 *
 * Founder-only. Query recent analysis_runs, parse Skills sections, classify
 * every Other Skills item via /api/internal/classify-skills. Shows a table
 * of jobs with action-needed items highlighted.
 *
 * All Supabase queries run server-side. Classification happens client-side
 * (one batch call per run, triggered on load).
 */
import { redirect }      from "next/navigation";
import Link              from "next/link";
import { createClient }  from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import SkillsAuditClient from "./SkillsAuditClient";

export const dynamic = "force-dynamic";

export interface RunRow {
  run_id:       string;
  job_id:       string;
  job_title:    string;
  company:      string;
  role_family:  string;
  lex_vertical: string | null;
  other_items:  string[];
  all_labels:   Record<string, string[]>;
}

const VERT_MAP: Record<string, string> = {
  nursing: "nursing",
  tech:    "tech",
  manual:  "cleaning",
};

function extractSkills(md: string): Record<string, string[]> {
  const lines = md.split("\n");
  let inSkills = false;
  const result: Record<string, string[]> = {};
  const labelRe = /^\s*(?:[-*•]\s+)?\*\*([^*]+?):\*\*\s*(.*)/;

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

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: runs } = await admin
    .from("analysis_runs")
    .select("id, job_id, tailored_md, jd_analysis_result, created_at")
    .not("tailored_md", "is", null)
    .or("is_stale.is.null,is_stale.eq.false")
    .order("created_at", { ascending: false })
    .limit(200);

  const jobIds = [...new Set((runs ?? []).map((r) => r.job_id as string).filter(Boolean))];
  const { data: jobsRaw } = await admin
    .from("jobs")
    .select("id, title, company")
    .in("id", jobIds);

  const jobMap = new Map((jobsRaw ?? []).map((j) => [j.id as string, j]));
  const seenJobs = new Set<string>();
  const rows: RunRow[] = [];

  for (const run of runs ?? []) {
    const jid = run.job_id as string;
    if (!jid || seenJobs.has(jid)) continue;
    seenJobs.add(jid);

    const tailored = (run.tailored_md as string) ?? "";
    const jdAnalysis = (run.jd_analysis_result as Record<string, string> | null) ?? {};
    const roleFamily = jdAnalysis.role_family ?? "master";
    const lexVertical = VERT_MAP[roleFamily] ?? null;

    const allLabels = extractSkills(tailored);
    const otherKey  = Object.keys(allLabels).find(
      (k) => k.toLowerCase().includes("other") || k.toLowerCase().includes("technical")
    );
    const otherItems = otherKey ? allLabels[otherKey] : [];

    const job = jobMap.get(jid);
    rows.push({
      run_id:       run.id as string,
      job_id:       jid,
      job_title:    (job?.title as string) ?? "",
      company:      (job?.company as string) ?? "",
      role_family:  roleFamily,
      lex_vertical: lexVertical,
      other_items:  otherItems,
      all_labels:   allLabels,
    });
  }

  const totalRuns = (runs ?? []).length;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <Link href="/dashboard/beta" className="hover:text-text transition-colors">Beta</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">Skills Audit</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Skills Audit — Other Skills classifier</h1>
        <p className="text-[12px] text-text-2 mt-1 max-w-2xl">
          Reads every recent analysis run, extracts Other Skills items, and classifies each via the
          deterministic lexicon. Shows which items need to be added to the lexicon (
          <code className="font-mono text-[11px]">nursing.json</code>) vs already correct.
          No AI calls.
        </p>
      </div>

      <div className="px-6 py-5">
        <SkillsAuditClient rows={rows} totalRuns={totalRuns} />
      </div>
    </div>
  );
}
