/**
 * /admin/activity — User activity feed
 *
 * Shows what users are doing: logins, analyses started/completed, emails sent,
 * profiles saved, cover letters generated, applications, billing events.
 *
 * Filterable by user and event type.
 * Also shows last-active time, total analyses, total sends per user.
 */
import { requireAdmin } from "@/lib/admin/guard";

function timeAgo(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60)          return "just now";
  if (secs < 3600)        return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)       return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 7)   return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
import Link from "next/link";

export const metadata = { title: "Activity — Admin — JobTrackr" };
export const dynamic  = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ user?: string; event?: string }>;
}

export default async function AdminActivityPage({ searchParams }: PageProps) {
  const sp        = await searchParams;
  const filterUser = sp.user ?? null;
  const filterEvent = sp.event ?? null;

  const { admin } = await requireAdmin();

  const now    = new Date();
  const d30ago = new Date(now.getTime() - 30 * 86400_000);

  // Core queries — always exist
  const [
    { data: allUsers },
    { data: recentRuns },
    { data: recentLetters },
  ] = await Promise.all([
    admin.from("users").select("id, email, role, created_at"),
    admin.from("analysis_runs").select("user_id, status, created_at")
      .gte("created_at", d30ago.toISOString()),
    admin.from("cover_letters").select("user_id, status, created_at")
      .gte("created_at", d30ago.toISOString()),
  ]);

  type EventRow  = { id?: string; user_id: string; event_type: string; metadata: Record<string, unknown>; ip?: string; country?: string; city?: string; device?: string; created_at: string };
  type UserRow   = { id: string; email: string; role: string; created_at: string };

  // Optional observability table — only exists after migration 055.
  const safeQuery = <T,>(q: PromiseLike<{ data: T[] | null }>) =>
    Promise.resolve(q).then((r) => r.data ?? []).catch((): T[] => []);

  const eventsQuery = filterUser
    ? admin.from("user_events").select("*").eq("user_id", filterUser)
    : admin.from("user_events").select("*");
  const rawEvents = await safeQuery(
    eventsQuery.order("created_at", { ascending: false }).limit(200)
  );

  const events  = rawEvents as EventRow[];
  const users   = (allUsers     ?? []) as UserRow[];
  const runs    = (recentRuns   ?? []) as { user_id: string; status: string; created_at: string }[];
  const letters = (recentLetters ?? []) as { user_id: string; status: string; created_at: string }[];

  const emailById = users.reduce<Record<string, string>>((a, u) => { a[u.id] = u.email; return a; }, {});

  // Per-user stats for the sidebar
  const runsByUser    = runs.reduce<Record<string, number>>((a, r) => { a[r.user_id] = (a[r.user_id] ?? 0) + 1; return a; }, {});
  const lettersByUser = letters.filter((l) => l.status === "completed")
    .reduce<Record<string, number>>((a, l) => { a[l.user_id] = (a[l.user_id] ?? 0) + 1; return a; }, {});

  // Available event types for filter chips (empty until migration 055 applied)
  const allEventsResult = await safeQuery(admin.from("user_events").select("event_type"));
  const eventTypes = [...new Set((allEventsResult as { event_type: string }[]).map((e) => e.event_type))].sort();

  // Filtered events
  const filtered = events.filter((e) => {
    if (filterEvent && e.event_type !== filterEvent) return false;
    return true;
  });

  // Color per event type
  const eventColor: Record<string, string> = {
    "login":                  "bg-blue-100 text-blue-700",
    "logout":                 "bg-slate-100 text-slate-600",
    "analysis_started":       "bg-amber-100 text-amber-700",
    "analysis_completed":     "bg-emerald-100 text-emerald-700",
    "analysis_failed":        "bg-red-100 text-red-700",
    "analysis_cancelled":     "bg-slate-100 text-slate-600",
    "email_sent":             "bg-purple-100 text-purple-700",
    "cover_letter_generated": "bg-indigo-100 text-indigo-700",
    "cv_downloaded":          "bg-teal-100 text-teal-700",
    "profile_saved":          "bg-orange-100 text-orange-700",
    "plan_upgraded":          "bg-emerald-100 text-emerald-700",
    "trial_started":          "bg-blue-100 text-blue-700",
  };

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-caption text-text-3 mb-1">
          <Link href="/admin" className="hover:text-text">Admin</Link>
          <span>/</span><span className="text-text-2">Activity</span>
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-lead font-semibold text-text">User activity</h1>
          <span className="text-label text-text-3">{filtered.length} events shown</span>
        </div>
      </div>

      <div className="px-6 py-5 flex gap-6 max-w-7xl">

        {/* Left: event feed */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Event type filter chips */}
          <div className="flex flex-wrap gap-2">
            <Link
              href={filterUser ? `/admin/activity?user=${filterUser}` : "/admin/activity"}
              className={`px-2.5 py-1 rounded-full text-caption font-medium border transition-colors ${!filterEvent ? "bg-text text-bg border-text" : "border-border text-text-2 hover:bg-[var(--sidebar-active-bg)]"}`}
            >
              All events
            </Link>
            {eventTypes.map((et) => (
              <Link
                key={et}
                href={`/admin/activity?${filterUser ? `user=${filterUser}&` : ""}event=${et}`}
                className={`px-2.5 py-1 rounded-full text-caption font-medium border transition-colors ${filterEvent === et ? "bg-text text-bg border-text" : "border-border text-text-2 hover:bg-[var(--sidebar-active-bg)]"}`}
              >
                {et.replace(/_/g, " ")}
              </Link>
            ))}
            {eventTypes.length === 0 && (
              <span className="text-label text-text-3">No events yet — activity populates as users interact with the app.</span>
            )}
          </div>

          {/* If filtering by user, show who */}
          {filterUser && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
              <span className="text-label text-blue-700">Showing activity for: <span className="font-semibold">{emailById[filterUser] ?? filterUser}</span></span>
              <Link href="/admin/activity" className="ml-auto text-caption text-blue-600 hover:underline">Clear filter</Link>
            </div>
          )}

          {/* Event list */}
          {filtered.length === 0 ? (
            <div className="bg-surface border border-border rounded-md px-4 py-8 text-center text-text-3 text-label">
              No events{filterEvent ? ` of type "${filterEvent}"` : ""} yet.
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-md divide-y divide-border">
              {filtered.map((e, i) => (
                <div key={e.id ?? i} className="flex items-start gap-3 px-4 py-3">
                  <div className="shrink-0 mt-0.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-micro font-semibold ${eventColor[e.event_type] ?? "bg-slate-100 text-slate-700"}`}>
                      {e.event_type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/admin/activity?user=${e.user_id}`}
                        className="text-label font-medium text-text hover:underline truncate"
                      >
                        {emailById[e.user_id] ?? e.user_id.slice(0, 12) + "…"}
                      </Link>
                      {e.country && (
                        <span className="text-caption text-text-3">{e.city ? `${e.city}, ` : ""}{e.country}</span>
                      )}
                      {e.device && (
                        <span className="text-micro bg-[var(--sidebar-active-bg)] px-1.5 py-0.5 rounded text-text-3">{e.device}</span>
                      )}
                    </div>
                    {e.metadata && Object.keys(e.metadata).length > 0 && (
                      <p className="text-caption text-text-3 font-mono mt-0.5 truncate max-w-lg">
                        {JSON.stringify(e.metadata)}
                      </p>
                    )}
                  </div>
                  <span className="text-caption text-text-3 tabular-nums shrink-0">{timeAgo(e.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: per-user summary sidebar */}
        <div className="w-64 shrink-0 hidden lg:block">
          <h2 className="text-label font-semibold text-text-3 uppercase tracking-widest mb-3">All users</h2>
          <div className="space-y-1">
            {users.map((u) => (
              <Link
                key={u.id}
                href={`/admin/activity?user=${u.id}`}
                className={`flex items-center justify-between rounded-md px-2.5 py-2 text-label transition-colors ${filterUser === u.id ? "bg-[var(--sidebar-active-bg)] text-text font-semibold" : "text-text-2 hover:bg-[var(--sidebar-active-bg)]"}`}
              >
                <span className="truncate max-w-[140px]">{u.email}</span>
                <div className="flex gap-1 shrink-0">
                  {runsByUser[u.id] > 0 && (
                    <span className="text-micro bg-amber-100 text-amber-700 px-1.5 rounded-full">{runsByUser[u.id]}</span>
                  )}
                  {lettersByUser[u.id] > 0 && (
                    <span className="text-micro bg-purple-100 text-purple-700 px-1.5 rounded-full">{lettersByUser[u.id]}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
          <p className="text-micro text-text-3 mt-3">🟡 = analyses  🟣 = letters (30d)</p>
        </div>
      </div>
    </div>
  );
}
