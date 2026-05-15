import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { SidebarNav } from "@/components/SidebarNav";
import { ThemeProvider } from "@/components/ThemeProvider";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: userData } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  const isAdmin = !!userData && ["founder", "admin"].includes(userData.role as string);

  // Fetch profiles with new-job counts for sidebar badges
  const { data: profileRows } = await supabase
    .from("search_profiles")
    .select("id, name")
    .order("created_at", { ascending: true });

  const profiles = (profileRows ?? []) as { id: string; name: string }[];
  const profileIds = profiles.map((p) => p.id);

  const [{ data: unseenRows }, { data: runRows }] = await Promise.all([
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
      {/* Sidebar — fixed width, full height */}
      <div className="w-[220px] shrink-0 hidden md:flex flex-col border-r border-[var(--sidebar-border)]">
        <SidebarNav email={user.email!} profiles={sidebarProfiles} isAdmin={isAdmin} />
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

        {children}
      </div>
    </div>
    </ThemeProvider>
  );
}
