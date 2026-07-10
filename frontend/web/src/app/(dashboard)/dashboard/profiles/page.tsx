/**
 * /dashboard/profiles — My profiles listing.
 *
 * Lives here so the main dashboard can stay focused on the unified jobs
 * board. Same table that used to be on the dashboard; same RunNow / Copy
 * / Delete actions; same routing into per-profile job views. No KPIs,
 * no Jobs feed — this page is just the profiles table.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ProfilesTable, type ProfileRow, type ProfileRunRow } from "@/components/profiles/ProfilesTable";
import { ResumePausedBanner } from "@/components/profiles/ResumePausedBanner";
import { BackButton } from "@/components/dashboard/BackButton";
import { AddJobButton } from "@/components/jobs/AddJobButton";
import { Inbox } from "lucide-react";

export default async function ProfilesListPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [{ data: profileRows }, { data: pauseRows }] = await Promise.all([
    supabase
      .from("search_profiles")
      .select("id, name, is_active, is_manual, keywords, location, schedule_cron")
      .order("created_at", { ascending: false }),
    supabase.from("profile_pause_state").select("profile_id"),
  ]);
  const pausedCount = pauseRows?.length ?? 0;

  const profiles = (profileRows ?? []) as ProfileRow[];

  if (profiles.length === 0) {
    return <EmptyState />;
  }

  const ids = profiles.map((p) => p.id);

  const [
    { data: jobRows },
    { data: unseenRows },
    { data: appliedRows },
    { data: runRows },
  ] = await Promise.all([
    supabase.from("jobs").select("profile_id").in("profile_id", ids)
      .eq("is_expired", false).eq("is_dead_link", false).is("dismissed_at", null),
    supabase.from("jobs").select("profile_id").in("profile_id", ids)
      .eq("is_expired", false).eq("is_dead_link", false).is("seen_at", null).is("dismissed_at", null),
    supabase.from("jobs").select("profile_id").in("profile_id", ids).not("applied_at", "is", null),
    supabase.from("run_logs")
      .select("profile_id, status, started_at, finished_at, jobs_saved, error_message")
      .in("profile_id", ids).order("started_at", { ascending: false }).limit(ids.length * 5),
  ]);

  function countBy(rows: { profile_id: string }[] | null) {
    return ((rows ?? []) as { profile_id: string }[]).reduce<Record<string, number>>(
      (acc, r) => { acc[r.profile_id] = (acc[r.profile_id] ?? 0) + 1; return acc; }, {}
    );
  }

  const totalCounts   = countBy(jobRows);
  const unseenCounts  = countBy(unseenRows);
  const appliedCounts = countBy(appliedRows);

  const latestRun = ((runRows ?? []) as ProfileRunRow[]).reduce<Record<string, ProfileRunRow>>((acc, r) => {
    if (!acc[r.profile_id]) acc[r.profile_id] = r;
    return acc;
  }, {});

  const activeCount = profiles.filter((p) => p.is_active).length;

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="mb-1.5">
              <BackButton />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Job Searches</span>
            </div>
            <h1 className="text-[16px] font-semibold text-text">Job Searches</h1>
            <p className="text-[12px] text-text-2 mt-0.5">
              {profiles.length} search{profiles.length !== 1 ? "es" : ""} · {activeCount} auto-scheduled
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AddJobButton variant="primary" />
            <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue text-[13px]">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              New search
            </Link>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 anim-in">
        <ResumePausedBanner count={pausedCount} />
        <ProfilesTable
          profiles={profiles}
          totalCounts={totalCounts}
          unseenCounts={unseenCounts}
          appliedCounts={appliedCounts}
          latestRun={latestRun}
        />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Job Searches</h1>
      </div>
      <div className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12">
        <div className="text-center max-w-md anim-in">
          <div className="w-14 h-14 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center mx-auto mb-4">
            <Inbox className="w-7 h-7 text-[var(--brand)]" />
          </div>
          <h2 className="text-[16px] font-semibold text-text mb-2">No profiles yet</h2>
          <p className="text-[13px] text-text-2 leading-relaxed mb-6">
            Create a search profile to start collecting matching jobs across boards.
          </p>
          <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue text-[13px] px-4 py-2">
            Create your first profile →
          </Link>
        </div>
      </div>
    </div>
  );
}
