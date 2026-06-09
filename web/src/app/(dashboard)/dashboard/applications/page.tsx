/**
 * /dashboard/applications — the outbox (V2 redesign).
 *
 * 2 tabs:
 *   pool — every job with a completed cover letter that hasn't been applied
 *          or dismissed yet. Filter: !applied_at && !dismissed_at.
 *          (Combines the old pool/email/apply tabs into one.)
 *   sent — applied_at IS NOT NULL.
 *
 * Archive removes a card from this screen entirely. Archived jobs live in
 * the dashboard / per-profile archive view.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { Inbox } from "lucide-react";
import {
  ApplicationStatusTabs,
  type ApplicationStatusCounts,
  type ApplicationStatusKey,
} from "@/components/applications/ApplicationStatusTabs";
import { type ApplicationRowV2 } from "@/components/applications/ApplicationCardV2";
import { ApplicationCardListV2 } from "@/components/applications/ApplicationCardListV2";
import { BackButton } from "@/components/dashboard/BackButton";
import { MarkApplicationsSeenOnLoad } from "@/components/applications/MarkApplicationsSeenOnLoad";

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const rawTab = sp.status as ApplicationStatusKey | undefined;
  const validTab: ApplicationStatusKey = rawTab === "sent" ? "sent" : "pool";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // ── 1. Cover letters ──────────────────────────────────────────────────────
  const { data: letters } = await supabase
    .from("cover_letters")
    .select("id, job_id, completed_at, created_at")
    .eq("user_id", user.id)
    .eq("status", "completed")
    .eq("is_stale", false)
    .order("completed_at", { ascending: false });

  const letterRows = (letters ?? []) as Array<{
    id:            string;
    job_id:        string;
    completed_at:  string | null;
    created_at:    string;
  }>;

  if (letterRows.length === 0) {
    return <EmptyState />;
  }

  const jobIds = Array.from(new Set(letterRows.map((l) => l.job_id)));

  // ── 2. Jobs ───────────────────────────────────────────────────────────────
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, profile_id, title, company, location, url, applied_at, dismissed_at, contact_email, hiring_manager")
    .in("id", jobIds);

  const jobById = new Map(
    ((jobs ?? []) as Array<{
      id:                string;
      profile_id:        string;
      title:             string | null;
      company:           string | null;
      location:          string | null;
      url:               string;
      applied_at:        string | null;
      dismissed_at:      string | null;
      contact_email:     string | null;
      hiring_manager:    string | null;
    }>).map((j) => [j.id, j]),
  );

  // ── 3. Latest non-stale analysis_runs per job ─────────────────────────────
  const { data: runs } = await supabase
    .from("analysis_runs")
    .select("id, job_id, tailored_match_score, tailored_pdf_storage_path, tailored_cv_storage_path, created_at")
    .in("job_id", jobIds)
    .eq("is_stale", false)
    .order("created_at", { ascending: false });

  const runByJob = new Map<string, {
    id: string;
    tailored_match_score: number | null;
    tailored_pdf_storage_path: string | null;
    tailored_cv_storage_path: string | null;
  }>();
  for (const r of (runs ?? []) as Array<{
    id: string; job_id: string;
    tailored_match_score: number | null;
    tailored_pdf_storage_path: string | null;
    tailored_cv_storage_path: string | null;
  }>) {
    if (!runByJob.has(r.job_id)) runByJob.set(r.job_id, {
      id: r.id,
      tailored_match_score: r.tailored_match_score,
      tailored_pdf_storage_path: r.tailored_pdf_storage_path,
      tailored_cv_storage_path: r.tailored_cv_storage_path,
    });
  }

  // ── 4. Profile names ──────────────────────────────────────────────────────
  const profileIds = Array.from(new Set(
    Array.from(jobById.values()).map((j) => j.profile_id),
  ));
  const { data: profiles } = profileIds.length > 0
    ? await supabase.from("search_profiles").select("id, name").in("id", profileIds)
    : { data: [] as Array<{ id: string; name: string }> };
  const profileNameById = new Map(
    ((profiles ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
  );

  // ── 5. Build rows ─────────────────────────────────────────────────────────
  const allRows: ApplicationRowV2[] = [];
  for (const l of letterRows) {
    const j = jobById.get(l.job_id);
    if (!j) continue;
    const run = runByJob.get(l.job_id);
    allRows.push({
      letter_id:                 l.id,
      letter_completed_at:       l.completed_at,
      job_id:                    j.id,
      job_title:                 j.title ?? "(untitled)",
      job_company:               j.company ?? "",
      job_location:              j.location ?? "",
      job_url:                   j.url,
      job_applied_at:            j.applied_at,
      job_dismissed_at:          j.dismissed_at,
      job_contact_email:         j.contact_email,
      job_hiring_manager:        j.hiring_manager,
      profile_id:                j.profile_id,
      profile_name:              profileNameById.get(j.profile_id) ?? "",
      latest_run_id:             run?.id ?? null,
      tailored_match_score:      run?.tailored_match_score ?? null,
      tailored_pdf_storage_path: run?.tailored_pdf_storage_path ?? null,
      tailored_cv_storage_path:  run?.tailored_cv_storage_path ?? null,
    });
  }

  // ── 6. Bucket filtering (2-tab) ───────────────────────────────────────────
  //   pool: everything not applied AND not dismissed
  //   sent: applied_at IS NOT NULL
  // Dismissed (archived) jobs are NOT shown on this screen at all — they
  // appear in the dashboard / per-profile archive view.
  const isPool = (r: ApplicationRowV2) => !r.job_applied_at && !r.job_dismissed_at;
  // Exclude dismissed jobs from the Sent tab — if user archives a job they
  // already applied to, it should leave this screen (lives in the archive view).
  const isSent = (r: ApplicationRowV2) => !!r.job_applied_at && !r.job_dismissed_at;

  const counts: ApplicationStatusCounts = {
    pool: allRows.filter(isPool).length,
    sent: allRows.filter(isSent).length,
  };

  const visible = allRows.filter((r) =>
    validTab === "pool" ? isPool(r) : isSent(r)
  );

  const TAB_HELP: Record<ApplicationStatusKey, string> = {
    pool: "Review your tailored CV, cover letter, and email message for each job. Edit anything, save your changes, then send or apply. Cards with a contact email send in one click; cards without one let you copy the message and apply via the job link.",
    sent: "Jobs you've applied to. Tap Email message to see (and copy) what you sent.",
  };

  const tabEmpty = (
    <div className="bg-surface border border-border rounded-md py-12 text-center anim-in anim-delay-2">
      <p className="text-[13px] font-medium text-text mb-1">Nothing here yet</p>
      <p className="text-[12px] text-text-2">
        {validTab === "pool"
          ? "Cover letters waiting to be reviewed and sent will appear here."
          : "Jobs you mark as applied will appear here."}
      </p>
    </div>
  );

  return (
    <div className="min-h-full">
      <MarkApplicationsSeenOnLoad />
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="mb-1.5">
              <BackButton />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Applications</span>
            </div>
            <h1 className="text-[16px] font-semibold text-text">Applications</h1>
            <p className="text-[12px] text-text-2 mt-0.5">
              {allRows.length} job{allRows.length !== 1 ? "s" : ""} with a completed cover letter
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4 max-w-5xl mx-auto w-full">
        <div className="anim-in">
          <Suspense>
            <ApplicationStatusTabs counts={counts} />
          </Suspense>
        </div>

        <p className="text-[12px] text-text-2 anim-in anim-delay-1">
          {TAB_HELP[validTab]}
        </p>

        <div className="anim-in anim-delay-2">
          <ApplicationCardListV2 rows={visible} tab={validTab} empty={tabEmpty} />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Applications</h1>
      </div>
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="text-center max-w-md anim-in">
          <div className="w-14 h-14 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center mx-auto mb-4">
            <Inbox className="w-7 h-7 text-[var(--brand)]" />
          </div>
          <h2 className="text-[16px] font-semibold text-text mb-2">No applications yet</h2>
          <p className="text-[13px] text-text-2 leading-relaxed mb-6">
            Generate a cover letter from any job&apos;s analysis page and it&apos;ll show up here ready for review.
          </p>
          <Link href="/dashboard" className="gh-btn gh-btn-blue text-[13px] px-4 py-2">
            Go to the job board →
          </Link>
        </div>
      </div>
    </div>
  );
}
