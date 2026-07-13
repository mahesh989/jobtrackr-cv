import { createClient } from "@/lib/supabase/server";
import { SidebarNav } from "@/components/SidebarNav";
import { MobileNav } from "@/components/MobileNav";

interface SidebarProfile {
  id: string;
  name: string;
  newCount: number;
  isRunning: boolean;
}

interface Props {
  userId: string;
  email: string;
  role: string;
  userView: boolean;
}

/**
 * Fetches sidebar data (profiles, unseen counts, running status, pool count)
 * and renders the desktop SidebarNav. Wrapped in Suspense by the layout so
 * the page content streams immediately while this loads.
 *
 * The pool count is the expensive part (3-step join). Profiles, unseen counts,
 * and running status are fast parallel queries.
 */
export async function SidebarData({ userId, email, role, userView }: Props) {
  const supabase = await createClient();

  const [{ data: profileRows }, { data: userRow }] = await Promise.all([
    supabase
      .from("search_profiles")
      .select("id, name")
      .order("created_at", { ascending: true }),
    supabase
      .from("users")
      .select("applications_seen_at")
      .eq("id", userId)
      .single(),
  ]);

  const profiles = (profileRows ?? []) as { id: string; name: string }[];
  const fullProfileIds = profiles.map((p) => p.id);
  const applicationsSeenAt =
    (userRow as { applications_seen_at: string | null } | null)?.applications_seen_at ?? null;

  // Pool badge — must match the Applications page filter exactly.
  let poolLetters = supabase
    .from("cover_letters")
    .select("id, job_id, completed_at, jobs!inner(applied_at, dismissed_at)")
    .eq("user_id", userId)
    .eq("status", "completed")
    .eq("is_stale", false)
    .is("jobs.applied_at", null)
    .is("jobs.dismissed_at", null);
  if (applicationsSeenAt) poolLetters = poolLetters.gt("completed_at", applicationsSeenAt);

  const [{ data: unseenRows }, { data: runRows }, { data: letterRowsForBadge }] =
    await Promise.all([
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
      poolLetters,
    ]);

  let poolCount = 0;
  const letterJobIds = Array.from(
    new Set(((letterRowsForBadge ?? []) as { job_id: string }[]).map((l) => l.job_id)),
  );
  if (letterJobIds.length > 0) {
    const { data: runsForBadge } = await supabase
      .from("analysis_runs")
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
        poolCount={poolCount ?? 0}
        role={role}
        userView={userView}
      />
      <div
        className="shrink-0 hidden md:flex flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]"
        style={{ width: "var(--sidebar-width)" }}
      >
        <SidebarNav
          email={email}
          profiles={sidebarProfiles}
          poolCount={poolCount ?? 0}
          role={role}
          userView={userView}
        />
      </div>
    </>
  );
}
