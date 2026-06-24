/**
 * Profiles table — extracted from the old dashboard. Now lives on its own
 * page at /dashboard/profiles so the main dashboard can stay focused on
 * the unified jobs board.
 *
 * Pure presentational component: takes already-fetched profiles + per-
 * profile counts + latest run, renders the table. Server component so it
 * can statically include the Run / Jobs / Copy / Delete row actions
 * (which are client components themselves).
 */

import Link from "next/link";
import { RunNowButton }       from "@/components/RunNowButton";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { CopyProfileButton }   from "@/components/CopyProfileButton";

export interface ProfileRow {
  id:             string;
  name:           string;
  is_active:      boolean;
  is_manual?:     boolean;
  keywords:       string[];
  location:       string;
  schedule_cron:  string;
}

export interface ProfileRunRow {
  profile_id:     string;
  status:         string;
  started_at:     string;
  finished_at:    string | null;
  jobs_saved:     number;
  error_message:  string | null;
}

interface Props {
  profiles:       ProfileRow[];
  totalCounts:    Record<string, number>;
  unseenCounts:   Record<string, number>;
  appliedCounts:  Record<string, number>;
  latestRun:      Record<string, ProfileRunRow>;
}

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
  const diff  = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)  return "just now";
  if (hours < 1) return `${mins}m ago`;
  if (days < 1)  return `${hours}h ago`;
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function ProfilesTable({
  profiles, totalCounts, unseenCounts, appliedCounts, latestRun,
}: Props) {
  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="overflow-x-auto">
      <div className="min-w-[880px]">
      <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-surface-2 border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
        <div className="col-span-3">Profile</div>
        <div className="col-span-2">Keywords</div>
        <div className="col-span-1 text-center">New</div>
        <div className="col-span-1 text-center">Total</div>
        <div className="col-span-1 text-center">Applied</div>
        <div className="col-span-1">Last run</div>
        <div className="col-span-3 text-right">Actions</div>
      </div>

      {profiles.map((p, i) => {
        const run       = latestRun[p.id];
        const newJobs   = unseenCounts[p.id] ?? 0;
        const total     = totalCounts[p.id] ?? 0;
        const applied   = appliedCounts[p.id] ?? 0;
        const isRunning = run?.status === "running";
        const failed    = run?.status === "failed";

        return (
          <div
            key={p.id}
            className={`grid grid-cols-12 gap-2 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2 transition-colors anim-in anim-delay-${Math.min(i + 1, 6)} ${
              isRunning ? "border-l-2 border-l-[var(--brand)]" : ""
            }`}
          >
            <div className="col-span-3 flex items-center gap-2 min-w-0">
              {isRunning && (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="dot-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75"/>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--brand)]"/>
                </span>
              )}
              <div className="min-w-0">
                <Link
                  href={`/dashboard/profiles/${p.id}/jobs`}
                  className="text-[13px] font-semibold text-text hover:text-[var(--brand)] truncate flex items-center gap-1.5 transition-colors"
                >
                  {p.name}
                </Link>
                {!p.is_manual && (
                  <span className={`text-[11px] ${p.is_active ? "text-[#1A7F37]" : "text-text-3"}`}>
                    {p.is_active ? `● ${scheduleLabel(p.schedule_cron)}` : "○ Manual"}
                  </span>
                )}
              </div>
            </div>

            <div className="col-span-2 flex items-center">
              <span className="text-[12px] text-text-2 truncate">
                {p.keywords.slice(0, 3).join(", ")}
                {p.keywords.length > 3 && <span className="text-text-3"> +{p.keywords.length - 3}</span>}
              </span>
            </div>

            <div className="col-span-1 flex items-center justify-center">
              {newJobs > 0 ? (
                <span className="badge badge-blue font-bold">{newJobs}</span>
              ) : (
                <span className="text-[12px] text-text-3">—</span>
              )}
            </div>

            <div className="col-span-1 flex items-center justify-center">
              <span className="text-[13px] font-medium text-text">{total}</span>
            </div>

            <div className="col-span-1 flex items-center justify-center">
              {applied > 0 ? (
                <span className="badge badge-green">{applied}</span>
              ) : (
                <span className="text-[12px] text-text-3">—</span>
              )}
            </div>

            <div className="col-span-1 flex items-center min-w-0">
              {!run ? (
                <span className="text-[12px] text-text-3">Never</span>
              ) : isRunning ? (
                <span className="text-[12px] text-[var(--brand)] font-medium flex items-center gap-1.5 whitespace-nowrap">
                  <svg className="animate-spin w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Running…
                </span>
              ) : failed ? (
                <span className="text-[12px] text-[#CF222E]">✗ Failed</span>
              ) : (
                <div className="whitespace-nowrap">
                  <span className="text-[12px] text-text-2">{timeAgo(run.started_at)}</span>
                  {run.jobs_saved > 0 && (
                    <span className="text-[11px] text-[#1A7F37] ml-1.5">+{run.jobs_saved}</span>
                  )}
                </div>
              )}
            </div>

            <div className="col-span-3 flex items-center justify-end gap-1.5">
              {p.is_manual ? null : (
                <>
                  <RunNowButton profileId={p.id} compact initialIsRunning={isRunning} />
                  <Link
                    href={`/dashboard/profiles/${p.id}/jobs`}
                    className={`gh-btn text-[12px] px-2.5 py-1 shrink-0 whitespace-nowrap ${newJobs > 0 ? "border-[var(--brand)]/40 text-[var(--brand)]" : ""}`}
                  >
                    {newJobs > 0 ? `${newJobs} new →` : "Jobs →"}
                  </Link>
                  <CopyProfileButton profileId={p.id} compact />
                  <DeleteProfileButton profileId={p.id} profileName={p.name} compact />
                </>
              )}
            </div>
          </div>
        );
      })}
      </div>
      </div>
    </div>
  );
}
