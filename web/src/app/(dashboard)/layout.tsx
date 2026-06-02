import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { SidebarNav } from "@/components/SidebarNav";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RunNotifier } from "@/components/RunNotifier";
import { SetupStepperBar } from "@/components/onboarding/SetupStepperBar";
import { getEntitlement } from "@/lib/billing/entitlements";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Subscription gate: a brand-new user with NO subscription row must pick a
  // plan to start their trial before they can use the dashboard. Canceled /
  // expired users keep read-only access here (enforcement is at the choke
  // points), and grandfathered beta / founder / admin resolve to "full".
  const ent = await getEntitlement(user.id);
  if (ent.status === "none") redirect("/onboarding/plan");

  // Fetch profiles with new-job counts for sidebar badges
  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id, name")
    .order("created_at", { ascending: true });

  const profiles = (profileRows ?? []) as { id: string; name: string }[];
  const profileIds = profiles.map((p) => p.id);

  // When did the user last open the Applications outbox? The badge only counts
  // pool items that completed after this, so once they view the page the badge
  // clears and stays cleared until a new cover letter lands.
  const { data: userRow } = await supabase
    .from("users")
    .select("applications_seen_at")
    .eq("id", user.id)
    .single();
  const applicationsSeenAt = (userRow as { applications_seen_at: string | null } | null)?.applications_seen_at ?? null;

  // Applications pool count: completed non-stale cover letters whose job is
  // still awaiting the email/no-email decision. RLS scopes to user_id. We only
  // count those that completed *after* the user last viewed the outbox.
  let poolQuery = supabase.from("cover_letters")
    .select("id, jobs!inner(pool_decision_at, applied_at, dismissed_at)", {
      count: "exact",
      head:  true,
    })
    .eq("user_id", user.id)
    .eq("status", "completed")
    .eq("is_stale", false)
    .is("jobs.pool_decision_at", null)
    .is("jobs.applied_at", null)
    .is("jobs.dismissed_at", null);
  if (applicationsSeenAt) poolQuery = poolQuery.gt("completed_at", applicationsSeenAt);

  const [{ data: unseenRows }, { data: runRows }, { count: poolCount }] = await Promise.all([
    supabase.from("jobs")
      .select("profile_id")
      .in("profile_id", profileIds)
      .eq("is_expired", false)
      .eq("is_dead_link", false)
      .is("seen_at", null)
      .is("dismissed_at", null),
    supabase.from("run_logs")
      .select("profile_id, status")
      .in("profile_id", profileIds)
      .eq("status", "running"),
    poolQuery,
  ]);

  const unseenCounts = ((unseenRows ?? []) as { profile_id: string }[]).reduce<Record<string, number>>(
    (acc, r) => { acc[r.profile_id] = (acc[r.profile_id] ?? 0) + 1; return acc; }, {}
  );
  const runningSet = new Set(
    ((runRows ?? []) as { profile_id: string }[]).map((r) => r.profile_id)
  );

  const sidebarProfiles = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    newCount: unseenCounts[p.id] ?? 0,
    isRunning: runningSet.has(p.id),
  }));

  return (
    <ThemeProvider>
    <div className="flex h-screen overflow-hidden bg-[var(--sidebar-bg)]">
      {/* Sidebar — width adapts per theme (Default 220px, cv-magic 256px).
          Width is set via inline style for reliable CSS-variable evaluation,
          since Tailwind arbitrary values with CSS vars can be flaky in v4. */}
      <div
        className="shrink-0 hidden md:flex flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]"
        style={{ width: "var(--sidebar-width)" }}
      >
        <SidebarNav
          email={user.email!}
          profiles={sidebarProfiles}
          poolCount={poolCount ?? 0}
        />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg overflow-y-auto">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 h-12 border-b border-border bg-surface shrink-0">
          <div className="w-5 h-5 rounded bg-blue flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="2" fill="white"/>
              <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="white" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </div>
          <span className="font-semibold text-text text-[13px]">JobTrackr</span>
          <div className="ml-auto flex items-center gap-2">
            <form action="/auth/signout" method="post">
              <button className="text-xs gh-btn">Sign out</button>
            </form>
          </div>
        </div>

        <Suspense fallback={null}>
          <SetupStepperBar />
        </Suspense>

        {children}
      </div>
      <RunNotifier />
    </div>
    </ThemeProvider>
  );
}
