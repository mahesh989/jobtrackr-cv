import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { RunNowButton } from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { CopyProfileButton } from "@/components/CopyProfileButton";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id, name, is_active, keywords, location, schedule_cron")
    .order("created_at", { ascending: false });

  const profiles = (profileRows ?? []) as Array<{
    id: string; name: string; is_active: boolean;
    keywords: string[]; location: string; schedule_cron: string;
  }>;
  const ids = profiles.map((p) => p.id);

  if (ids.length === 0) {
    return <EmptyState />;
  }

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

  type RunRow = { profile_id: string; status: string; started_at: string; finished_at: string | null; jobs_saved: number; error_message: string | null };
  const latestRun = ((runRows ?? []) as RunRow[]).reduce<Record<string, RunRow>>((acc, r) => {
    if (!acc[r.profile_id]) acc[r.profile_id] = r;
    return acc;
  }, {});

  // KPI totals
  const totalJobs   = Object.values(totalCounts).reduce((a, b) => a + b, 0);
  const totalNew    = Object.values(unseenCounts).reduce((a, b) => a + b, 0);
  const totalApplied = Object.values(appliedCounts).reduce((a, b) => a + b, 0);
  const activeCount  = profiles.filter((p) => p.is_active).length;

  function scheduleLabel(cron: string) {
    if (!cron) return "Manual";
    if (cron.includes("*/1") || cron === "0 21 * * *") return "Daily";
    const m = cron.match(/\*\/(\d+)/);
    if (m && parseInt(m[1]) > 1) return `Every ${m[1]} days`;
    if (cron.includes("* * 1")) return "Weekly Mon";
    if (cron.includes("* * 3")) return "Weekly Wed";
    if (cron.includes("* * 5")) return "Weekly Fri";
    return "Scheduled";
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins < 2)  return "just now";
    if (hours < 1) return `${mins}m ago`;
    if (days < 1)  return `${hours}h ago`;
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-semibold text-text">Dashboard</h1>
            <p className="text-[12px] text-text-2 mt-0.5">
              {profiles.length} profile{profiles.length !== 1 ? "s" : ""} · {activeCount} auto-scheduled
            </p>
          </div>
          <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue text-[13px]">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            New profile
          </Link>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* ── KPI bar ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 anim-in">
          <div className="kpi-card">
            <div className="kpi-value">{totalJobs.toLocaleString()}</div>
            <div className="kpi-label">Total jobs</div>
          </div>
          <div className={`kpi-card ${totalNew > 0 ? "border-[#0969DA] ring-1 ring-[#0969DA]/20" : ""}`}>
            <div className={`kpi-value ${totalNew > 0 ? "text-[#0969DA]" : ""}`}>{totalNew}</div>
            <div className="kpi-label">New · unseen</div>
          </div>
          <div className={`kpi-card ${totalApplied > 0 ? "border-[#1A7F37]/40" : ""}`}>
            <div className={`kpi-value ${totalApplied > 0 ? "text-[#1A7F37]" : ""}`}>{totalApplied}</div>
            <div className="kpi-label">Applied</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{activeCount}</div>
            <div className="kpi-label">Auto-scheduled</div>
          </div>
        </div>

        {/* ── Profile table ── */}
        <div className="anim-in anim-delay-1">
          <div className="bg-surface border border-border rounded-md overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-surface-2 border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
              <div className="col-span-3">Profile</div>
              <div className="col-span-2">Keywords</div>
              <div className="col-span-1 text-center">New</div>
              <div className="col-span-1 text-center">Total</div>
              <div className="col-span-1 text-center">Applied</div>
              <div className="col-span-2">Last run</div>
              <div className="col-span-2"></div>
            </div>

            {profiles.map((p, i) => {
              const run      = latestRun[p.id];
              const newJobs  = unseenCounts[p.id] ?? 0;
              const total    = totalCounts[p.id] ?? 0;
              const applied  = appliedCounts[p.id] ?? 0;
              const isRunning = run?.status === "running";
              const failed    = run?.status === "failed";

              return (
                <div
                  key={p.id}
                  className={`grid grid-cols-12 gap-2 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2 transition-colors anim-in anim-delay-${Math.min(i + 2, 6)} ${
                    isRunning ? "border-l-2 border-l-[#0969DA]" : ""
                  }`}
                >
                  {/* Profile name */}
                  <div className="col-span-3 flex items-center gap-2 min-w-0">
                    {isRunning && (
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="dot-ping absolute inline-flex h-full w-full rounded-full bg-[#0969DA] opacity-75"/>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[#0969DA]"/>
                      </span>
                    )}
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/profiles/${p.id}/jobs`}
                        className="text-[13px] font-semibold text-text hover:text-[#0969DA] truncate block transition-colors"
                      >
                        {p.name}
                      </Link>
                      <span className={`text-[11px] ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                        {p.is_active ? `● ${scheduleLabel(p.schedule_cron)}` : "○ Manual"}
                      </span>
                    </div>
                  </div>

                  {/* Keywords */}
                  <div className="col-span-2 flex items-center">
                    <span className="text-[12px] text-text-2 truncate">
                      {p.keywords.slice(0, 3).join(", ")}
                      {p.keywords.length > 3 && <span className="text-text-3"> +{p.keywords.length - 3}</span>}
                    </span>
                  </div>

                  {/* New */}
                  <div className="col-span-1 flex items-center justify-center">
                    {newJobs > 0 ? (
                      <span className="badge badge-blue font-bold">{newJobs}</span>
                    ) : (
                      <span className="text-[12px] text-text-3">—</span>
                    )}
                  </div>

                  {/* Total */}
                  <div className="col-span-1 flex items-center justify-center">
                    <span className="text-[13px] font-medium text-text">{total}</span>
                  </div>

                  {/* Applied */}
                  <div className="col-span-1 flex items-center justify-center">
                    {applied > 0 ? (
                      <span className="badge badge-green">{applied}</span>
                    ) : (
                      <span className="text-[12px] text-text-3">—</span>
                    )}
                  </div>

                  {/* Last run */}
                  <div className="col-span-2 flex items-center">
                    {!run ? (
                      <span className="text-[12px] text-text-3">Never</span>
                    ) : isRunning ? (
                      <span className="text-[12px] text-[#0969DA] font-medium flex items-center gap-1.5">
                        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                        Running…
                      </span>
                    ) : failed ? (
                      <span className="text-[12px] text-[#CF222E]">✗ Failed</span>
                    ) : (
                      <div>
                        <span className="text-[12px] text-text-2">{timeAgo(run.started_at)}</span>
                        {run.jobs_saved > 0 && (
                          <span className="text-[11px] text-[#1A7F37] ml-1.5">+{run.jobs_saved}</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="col-span-2 flex items-center justify-end gap-1.5">
                    <RunNowButton profileId={p.id} compact initialIsRunning={isRunning} />
                    <Link
                      href={`/dashboard/profiles/${p.id}/jobs`}
                      className={`gh-btn text-[12px] px-2.5 py-1 ${newJobs > 0 ? "border-[#0969DA]/40 text-[#0969DA]" : ""}`}
                    >
                      {newJobs > 0 ? `${newJobs} new →` : "Jobs →"}
                    </Link>
                    <CopyProfileButton profileId={p.id} compact />
                    <DeleteProfileButton profileId={p.id} profileName={p.name} compact />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quick links */}
        <div className="flex items-center gap-3 text-[12px] text-text-3 anim-in anim-delay-3">
          <Link href="/dashboard/profiles/new" className="hover:text-text transition-colors">+ New profile</Link>
          <span>·</span>
          <a href="/api/user/export" className="hover:text-text transition-colors">Export all data</a>
          <span>·</span>
          <Link href="/privacy" className="hover:text-text transition-colors">Privacy policy</Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="text-center max-w-sm anim-in">
        {/* Radar icon */}
        <div className="w-16 h-16 rounded-xl bg-[#0969DA]/10 border border-[#0969DA]/20 flex items-center justify-center mx-auto mb-5">
          <svg className="w-8 h-8 text-[#0969DA]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497z"/>
          </svg>
        </div>

        <h2 className="text-[18px] font-semibold text-text mb-2">Set up your first search profile</h2>
        <p className="text-[13px] text-text-2 leading-relaxed mb-6">
          A search profile tells JobTrackr what jobs to look for. Once created, it automatically scans 21+ Australian sources — government portals, ATS systems, healthcare boards — and AI-scores every result.
        </p>

        <div className="bg-surface border border-border rounded-md p-4 text-left mb-6 space-y-3">
          {[
            { n: "1", title: "Define keywords", desc: "e.g. \"Data Analyst, SQL, Power BI\"" },
            { n: "2", title: "Set a schedule",   desc: "Daily, every 2 days, or weekly" },
            { n: "3", title: "Review & track",   desc: "AI-scored feed, mark applied, export CSV" },
          ].map((s) => (
            <div key={s.n} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-[#0969DA] text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                {s.n}
              </span>
              <div>
                <p className="text-[13px] font-medium text-text">{s.title}</p>
                <p className="text-[12px] text-text-2">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <Link href="/dashboard/profiles/new" className="gh-btn gh-btn-blue w-full justify-center py-2 text-[13px]">
          Create your first profile
        </Link>
      </div>
    </div>
  );
}
