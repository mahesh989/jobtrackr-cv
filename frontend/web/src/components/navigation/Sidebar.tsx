import { createClient } from "@/lib/supabase/server";
import { SidebarLinks } from "@/components/navigation/SidebarLinks";
import { MobileNav } from "@/components/navigation/MobileNav";

interface SidebarProfile {
  id: string;
  name: string;
  newCount: number;
  isRunning: boolean;
}

interface Props {
  email: string;
  role: string;
  userView: boolean;
}

/**
 * Fetches sidebar data (profiles, unseen counts, running status) and renders
 * the desktop SidebarLinks. Wrapped in Suspense by the layout so the page
 * content streams immediately while this loads.
 *
 * All queries here are fast and parallel. The Applications pool badge — a
 * 3-step join plus a serial follow-up query on EVERY page load, by far the
 * most expensive thing the sidebar did — went with the /applications screen it
 * counted for. The board's own "Ready to apply" saved view carries that count
 * in the toolbar, computed client-side from jobs already in memory.
 */
export async function Sidebar({ email, role, userView }: Props) {
  const supabase = await createClient();

  const { data: profileRows, error: profilesError } = await supabase
    .from("search_profiles")
    .select("id, name")
    .order("created_at", { ascending: true });
  // Discarded errors here previously gave no signal at all when the
  // sidebar silently rendered wrong data on every page load — an empty
  // profile list (looks like "you have no search profiles"), a stale
  // "new" badge count, a stuck-looking running indicator, or a wrong
  // favourites count. This is a best-effort render (a failed sidebar
  // fetch shouldn't break the whole page), so behaviour is unchanged —
  // logging only, matching the class of bug in the audit's discarded-
  // `{error}` finding for this file (execution chunk C45).
  if (profilesError) console.error(`[Sidebar] search_profiles fetch failed: ${profilesError.message}`);

  const profiles = (profileRows ?? []) as { id: string; name: string }[];
  const fullProfileIds = profiles.map((p) => p.id);

  const [
    { data: unseenRows, error: unseenError },
    { data: runRows, error: runError },
    { count: starredCount, error: starredError },
  ] = await Promise.all([
      supabase
        .from("jobs")
        .select("profile_id")
        .in("profile_id", fullProfileIds)
        .eq("is_expired", false)
        .eq("is_dead_link", false)
        .is("seen_at", null)
        .is("dismissed_at", null),
      supabase
        .from("run_logs")
        .select("profile_id, status")
        .in("profile_id", fullProfileIds)
        .eq("status", "running"),
      supabase
        .from("jobs")
        .select("*", { count: "exact", head: true })
        .in("profile_id", fullProfileIds)
        .not("starred_at", "is", null)
        .is("dismissed_at", null),
    ]);
  if (unseenError) console.error(`[Sidebar] unseen-count fetch failed: ${unseenError.message}`);
  if (runError) console.error(`[Sidebar] running-status fetch failed: ${runError.message}`);
  if (starredError) console.error(`[Sidebar] starred-count fetch failed: ${starredError.message}`);

  const unseenCounts = ((unseenRows ?? []) as { profile_id: string }[]).reduce<
    Record<string, number>
  >((acc, r) => {
    acc[r.profile_id] = (acc[r.profile_id] ?? 0) + 1;
    return acc;
  }, {});
  const runningSet = new Set(
    ((runRows ?? []) as { profile_id: string }[]).map((r) => r.profile_id),
  );

  const sidebarProfiles: SidebarProfile[] = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    newCount: unseenCounts[p.id] ?? 0,
    isRunning: runningSet.has(p.id),
  }));

  return (
    <>
      <MobileNav
        email={email}
        profiles={sidebarProfiles}
        favouriteCount={starredCount ?? 0}
        role={role}
        userView={userView}
      />
      <div
        className="w-full hidden md:flex flex-col h-full min-h-0 border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]"
      >
        <SidebarLinks
          email={email}
          profiles={sidebarProfiles}
          favouriteCount={starredCount ?? 0}
          role={role}
          userView={userView}
        />
      </div>
    </>
  );
}
