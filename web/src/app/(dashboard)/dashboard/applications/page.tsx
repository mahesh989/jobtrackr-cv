/**
 * /dashboard/applications — the outbox.
 *
 * Bucket lifecycle:
 *   Pool (Application pool) — cover letter ready, user hasn't queued for review yet
 *                      (pool_decision_at IS NULL)
 *   Ready to email   — pool_decision_at set + contact_email IS NOT NULL
 *   Ready to apply   — pool_decision_at set + contact_email IS NULL (apply manually)
 *   Sent / Applied   — job.applied_at IS NOT NULL
 *   Archived         — job.dismissed_at IS NOT NULL
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { Inbox } from "lucide-react";
import { ApplicationStatusTabs, type ApplicationStatusCounts, type ApplicationStatusKey } from "@/components/applications/ApplicationStatusTabs";
import { ApplicationCard, type ApplicationRow } from "@/components/applications/ApplicationCard";
import { PoolBulkBar } from "@/components/applications/PoolBulkBar";
import { EmailBulkBar } from "@/components/applications/EmailBulkBar";

const LETTER_PREVIEW_CHARS = 180;

function letterPreview(s: string | null | undefined): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= LETTER_PREVIEW_CHARS) return flat;
  return flat.slice(0, LETTER_PREVIEW_CHARS).trimEnd() + "…";
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const rawTab = sp.status as ApplicationStatusKey | undefined;
  const validTab: ApplicationStatusKey =
    rawTab === "email" || rawTab === "apply" || rawTab === "sent" || rawTab === "archived"
      ? rawTab
      : "pool";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // ── 1. Cover letters ──────────────────────────────────────────────────────
  const { data: letters } = await supabase
    .from("cover_letters")
    .select("id, job_id, pass_3_final, completed_at, created_at, reviewed_at")
    .eq("user_id", user.id)
    .eq("status", "completed")
    .eq("is_stale", false)
    .order("completed_at", { ascending: false });

  const letterRows = (letters ?? []) as Array<{
    id:            string;
    job_id:        string;
    pass_3_final:  string | null;
    completed_at:  string | null;
    created_at:    string;
    reviewed_at:   string | null;
  }>;

  if (letterRows.length === 0) {
    return <EmptyState />;
  }

  const jobIds = Array.from(new Set(letterRows.map((l) => l.job_id)));

  // ── 2. Jobs ───────────────────────────────────────────────────────────────
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, profile_id, title, company, location, url, applied_at, dismissed_at, has_email, contact_email, hiring_manager, pool_decision_at")
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
      has_email:         boolean | null;
      contact_email:     string | null;
      hiring_manager:    string | null;
      pool_decision_at:  string | null;
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
  const allRows: ApplicationRow[] = [];
  for (const l of letterRows) {
    const j = jobById.get(l.job_id);
    if (!j) continue;
    const run = runByJob.get(l.job_id);
    allRows.push({
      letter_id:                 l.id,
      letter_completed_at:       l.completed_at,
      letter_preview:            letterPreview(l.pass_3_final),
      letter_reviewed_at:        l.reviewed_at,
      job_id:                    j.id,
      job_title:                 j.title ?? "(untitled)",
      job_company:               j.company ?? "",
      job_location:              j.location ?? "",
      job_url:                   j.url,
      job_applied_at:            j.applied_at,
      job_dismissed_at:          j.dismissed_at,
      job_contact_email:         j.contact_email,
      job_has_email:             !!j.has_email,
      job_pool_decision_at:      j.pool_decision_at,
      job_hiring_manager:        j.hiring_manager,
      profile_id:                j.profile_id,
      profile_name:              profileNameById.get(j.profile_id) ?? "",
      latest_run_id:             run?.id ?? null,
      tailored_match_score:      run?.tailored_match_score ?? null,
      tailored_pdf_storage_path: run?.tailored_pdf_storage_path ?? null,
      tailored_cv_storage_path:  run?.tailored_cv_storage_path ?? null,
    });
  }

  // ── 6. Bucket counts ──────────────────────────────────────────────────────
  // Lifecycle (post-039 + unified review):
  //   pool    — user hasn't queued the card for review yet ("Application pool" tab).
  //             pool_decision_at IS NULL.
  //   email   — REVIEW STAGE ("Ready to review" tab). Every queued card —
  //             email or no-email — is reviewed here. Filter: pool_decision_at
  //             SET and reviewed_at NULL.
  //   apply   — ACTION STAGE ("Ready to apply" tab). Email-channel cards show
  //             Send email; no-email cards show Copy email + Apply now.
  //             Filter: pool_decision_at SET and reviewed_at SET.
  //   sent    — applied_at SET.
  //   archived— dismissed_at SET.
  const isPool     = (r: ApplicationRow) => !r.job_applied_at && !r.job_dismissed_at && r.job_pool_decision_at === null;
  const isEmail    = (r: ApplicationRow) => !r.job_applied_at && !r.job_dismissed_at && r.job_pool_decision_at !== null && !r.letter_reviewed_at;
  const isApply    = (r: ApplicationRow) => !r.job_applied_at && !r.job_dismissed_at && r.job_pool_decision_at !== null && !!r.letter_reviewed_at;
  const isSent     = (r: ApplicationRow) => !!r.job_applied_at;
  const isArchived = (r: ApplicationRow) => !!r.job_dismissed_at && !r.job_applied_at;

  const counts: ApplicationStatusCounts = {
    pool:     allRows.filter(isPool).length,
    email:    allRows.filter(isEmail).length,
    apply:    allRows.filter(isApply).length,
    sent:     allRows.filter(isSent).length,
    archived: allRows.filter(isArchived).length,
  };

  // ── 7. Filter to current tab ──────────────────────────────────────────────
  const visible = allRows.filter((r) => {
    if (validTab === "pool")     return isPool(r);
    if (validTab === "email")    return isEmail(r);
    if (validTab === "apply")    return isApply(r);
    if (validTab === "sent")     return isSent(r);
    if (validTab === "archived") return isArchived(r);
    return false;
  });

  const TAB_HELP: Record<ApplicationStatusKey, string> = {
    pool:     "Cover letter is ready. Queue it for review (and optionally add a contact email), or archive it. The same review flow applies whether you have a contact email or not.",
    email:    "Review stage. Click Review on a card to preview and edit the email (subject + body), then Approve. Approved cards move to Ready to apply. Nothing leaves your account from this tab.",
    apply:    "Send / Apply stage. Cards with a contact email show Send email (dispatches via Gmail/Outlook). No-email cards show Copy email (paste into your own client) and Apply now (opens the job link). Mark applied when you're done.",
    sent:     "Jobs you've applied to. Track outcomes here.",
    archived: "Jobs you've dismissed after generating a letter.",
  };

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
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

      <div className="px-6 py-5 space-y-4 max-w-4xl">
        <div className="anim-in">
          <Suspense>
            <ApplicationStatusTabs counts={counts} />
          </Suspense>
        </div>

        <p className="text-[12px] text-text-2 anim-in anim-delay-1">
          {TAB_HELP[validTab]}
        </p>

        {visible.length === 0 ? (
          <div className="bg-surface border border-border rounded-md py-12 text-center anim-in anim-delay-2">
            <p className="text-[13px] font-medium text-text mb-1">Nothing here yet</p>
            <p className="text-[12px] text-text-2">
              {validTab === "pool"     && "Cover letters waiting to be queued for review will appear here."}
              {validTab === "email"    && "Cards queued for review will appear here. Generate a cover letter on a job to start."}
              {validTab === "apply"    && "Reviewed cards ready to be sent or applied to will appear here."}
              {validTab === "sent"     && "Jobs you mark as applied will appear here."}
              {validTab === "archived" && "Archived applications will appear here."}
            </p>
          </div>
        ) : validTab === "pool" ? (
          /* Pool tab uses the pool-bulk wrapper. */
          <div className="anim-in anim-delay-2">
            <PoolBulkBar rows={visible} />
          </div>
        ) : validTab === "email" ? (
          /* Ready-to-email uses the send-bulk wrapper (still allows per-card Send). */
          <div className="anim-in anim-delay-2">
            <EmailBulkBar rows={visible} />
          </div>
        ) : (
          /* Apply / Sent / Archived render plain. The card needs the current
             tab so it can pick the right primary action (Send email vs Apply now). */
          <div className="space-y-3 anim-in anim-delay-2">
            {visible.map((row) => (
              <ApplicationCard key={row.letter_id} row={row} tab={validTab} />
            ))}
          </div>
        )}
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
