import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/getUser";
import { SidebarNav } from "@/components/SidebarNav";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RunNotifier } from "@/components/RunNotifier";
import { SetupStepperBar } from "@/components/onboarding/SetupStepperBar";
import { getEntitlement } from "@/lib/billing/entitlements";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // getAuthUser is React.cache() — deduplicated with the page's own getUser call.
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");
  const supabase = await createClient();

  // Entitlement first — determines whether this is an admin or a regular user,
  // which controls which queries we run and what the sidebar renders.
  const ent = await getEntitlement(user.id);

  // Subscription gate: a brand-new user with NO subscription row must pick a
  // plan to start their trial before they can use the dashboard. Canceled /
  // expired users keep read-only access here (enforcement is at the choke
  // points), and grandfathered beta / founder / admin resolve to "full".
  if (ent.status === "none") redirect("/onboarding/plan");

  const isAdmin = ent.role === "founder" || ent.role === "admin";

  // "View as user" — an admin previewing the user-facing UI as themselves.
  // Set via /api/admin/view-as?mode=user (jt_user_view cookie). In this mode we
  // render the user nav + fetch the user sidebar data, and the dashboard page
  // skips its admin redirect.
  const userView = isAdmin && (await cookies()).get("jt_user_view")?.value === "1";

  // Admin users don't need profile badges, unseen counts, or pool counts —
  // they never interact with the user-facing job board from the admin nav.
  // Skip those queries entirely to keep layout load fast for admin pages.
  // In user-view we DO fetch them so the previewed user nav is populated.
  let sidebarProfiles: { id: string; name: string; newCount: number; isRunning: boolean }[] = [];
  let poolCount = 0;

  if (!isAdmin || userView) {
    const [{ data: profileRows }, { data: userRow }] = await Promise.all([
      supabase
        .from("search_profiles")
        .select("id, name")
        .order("created_at", { ascending: true }),
      supabase
        .from("users")
        .select("applications_seen_at")
        .eq("id", user.id)
        .single(),
    ]);

    const profiles = (profileRows ?? []) as { id: string; name: string }[];
    const profileIds = profiles.map((p) => p.id);
    const applicationsSeenAt = (userRow as { applications_seen_at: string | null } | null)?.applications_seen_at ?? null;

    // Pool badge — must match the Applications page filter exactly. A job is
    // "in pool" only when it has a COMPLETE set: cover letter + analysis run +
    // tailored CV. The page filter (isPool) and this badge are computed off
    // the same three queries; mismatched logic was producing a 40-count when
    // the page showed 0.
    let poolLetters = supabase.from("cover_letters")
      .select("id, job_id, completed_at, jobs!inner(applied_at, dismissed_at)")
      .eq("user_id", user.id)
      .eq("status", "completed")
      .eq("is_stale", false)
      .is("jobs.applied_at", null)
      .is("jobs.dismissed_at", null);
    if (applicationsSeenAt) poolLetters = poolLetters.gt("completed_at", applicationsSeenAt);

    const [{ data: unseenRows }, { data: runRows }, { data: letterRowsForBadge }] = await Promise.all([
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
      poolLetters,
    ]);

    const letterJobIds = Array.from(new Set(
      ((letterRowsForBadge ?? []) as { job_id: string }[]).map((l) => l.job_id),
    ));
    if (letterJobIds.length > 0) {
      const { data: runsForBadge } = await supabase.from("analysis_runs")
        .select("job_id, tailored_pdf_storage_path, tailored_cv_storage_path")
        .in("job_id", letterJobIds)
        .eq("is_stale", false);
      const completeJobs = new Set(
        ((runsForBadge ?? []) as {
          job_id: string;
          tailored_pdf_storage_path: string | null;
          tailored_cv_storage_path: string | null;
        }[])
          .filter((r) => !!(r.tailored_pdf_storage_path || r.tailored_cv_storage_path))
          .map((r) => r.job_id),
      );
      poolCount = letterJobIds.filter((id) => completeJobs.has(id)).length;
    }
    const unseenCounts = ((unseenRows ?? []) as { profile_id: string }[]).reduce<Record<string, number>>(
      (acc, r) => { acc[r.profile_id] = (acc[r.profile_id] ?? 0) + 1; return acc; }, {}
    );
    const runningSet = new Set(
      ((runRows ?? []) as { profile_id: string }[]).map((r) => r.profile_id)
    );
    sidebarProfiles = profiles.map((p) => ({
      id: p.id,
      name: p.name,
      newCount: unseenCounts[p.id] ?? 0,
      isRunning: runningSet.has(p.id),
    }));
  }

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
          role={ent.role}
          userView={userView}
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
