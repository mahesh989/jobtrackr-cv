/**
 * Main dashboard — two-part layout:
 *
 *   1. Profile management   — KPI strip + profiles table (existing).
 *   2. Unified jobs board   — JobTable across ALL profiles owned by the
 *      user, with the same chips/filters/sort/rail as a single-profile
 *      board. Each row shows a small "via <Profile name>" label.
 *
 * This file is the route shell only: auth, redirects, and rendering. All
 * fetching and derivation lives in features/dashboard/getDashboardData, which
 * is plain and unit-tested. The request-coupled bits stay here on purpose —
 * redirect() throws NEXT_REDIRECT to unwind the segment, and cookies() is
 * request-scoped.
 *
 * URL params reused 1:1 from the per-profile board:
 *   status, sort, dir, location, posted_within, min_keywords,
 *   visa_toggle, chips
 */

import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/features/auth/server";
import { getCachedProfiles } from "@/lib/queryCache";
import { ADMIN_ROLES } from "@/lib/constants";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Suspense } from "react";
import Link from "next/link";
import { HowItWorksDeck } from "@/features/onboarding/HowItWorksDeck";
import { StatCards } from "@/features/dashboard/StatCards";
import { PipelineDonut } from "@/features/dashboard/PipelineDonut";
import { ScrollToJobsOnFilter } from "@/features/jobs/components/ScrollToJobsOnFilter";
import { JobBoard } from "@/features/jobs/components/JobBoard";
import {
  getDashboardData,
  type DashboardProfile,
  type DashboardSearchParams,
} from "@/features/dashboard/getDashboardData";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  // getAuthUser is React.cache() — free if layout already called it this render.
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  // Admins/founders have no use for the user-facing job board dashboard.
  // Send them straight to the admin overview instead — UNLESS they've opted
  // into "View as user" (jt_user_view cookie), in which case let them see the
  // user dashboard with their own data.
  // These three only need `user.id`, so they go together rather than in a
  // three-deep chain — this prologue ran before ANY of the parallel batches
  // below and put ~2 serial round trips in front of every dashboard load.
  // getCachedProfiles is unstable_cache (30 s TTL per user, busted by
  // revalidateTag(`profiles-${user.id}`) on profile create/update/delete), so
  // it is usually free; the two queries are the real cost.
  // The admin redirect below still fires correctly — it just no longer blocks
  // the other two from starting. Admins pay a little wasted work on a request
  // they are redirecting away from anyway, which is the right trade.
  const [{ data: userRoleRow }, { data: prefRow }, profileRows] = await Promise.all([
    supabase.from("users").select("role").eq("id", user.id).single(),
    supabase.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
    getCachedProfiles(user.id),
  ]);
  const userRole = (userRoleRow as { role?: string } | null)?.role ?? "";
  const inUserView = (await cookies()).get("jt_user_view")?.value === "1";
  if ((ADMIN_ROLES as readonly string[]).includes(userRole) && !inUserView) redirect("/admin");

  const profiles = profileRows as DashboardProfile[];

  const result = await getDashboardData({ supabase, sp, profiles, prefRow });
  if (result.kind === "empty") {
    return <ReadyToScanScreen hasProfiles={result.hasProfiles} />;
  }
  const {
    typedJobs, funnelCounts, lensData,
    totalJobs, totalNew, totalApplied,
    mergedExcludeKeywords, isNewView,
  } = result.data;

  // Favourite/Applied are opened from their own sidebar links, not from a
  // funnel click inside the dashboard — the user came here for the filtered
  // board, not the account-wide stats. Skip the header/StatCards/PipelineDonut
  // so the board panels start right at the top of the page.
  const isFocusedStage = sp.stage === "favourite" || sp.stage === "applied";

  return (
    <div className="min-h-full">
      <div className="px-4 sm:px-6 py-5 space-y-6">
        {!isFocusedStage && (
          <>
            {/* ── KPI bar (interactive) ── */}
            <StatCards
              totalJobs={totalJobs}
              totalNew={totalNew}
              totalApplied={totalApplied}
            />

            {/* ── Pipeline analytics donut ── */}
            <PipelineDonut data={lensData} />
          </>
        )}

        {/* ── Unified jobs board (client-side instant filtering) ── */}
        <div id="jobs-board" className="anim-in anim-delay-2 space-y-4 pt-2 scroll-mt-4">
          {/* Smoothly scrolls here whenever a filter/sort changes. */}
          <Suspense><ScrollToJobsOnFilter /></Suspense>

          {/* ?status=new banner — each profile's latest fetched batch */}
          {isNewView && (
            <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 rounded-md bg-[var(--brand)]/8 border border-[var(--brand)]/30 text-label">
              <span className="text-text">
                <span className="font-semibold text-[var(--brand)]">Latest fetch</span>
                {" — "}showing each profile&apos;s most recent batch of new jobs. Your usual sort and filters apply.
              </span>
              <Link href="/dashboard" className="text-[var(--brand)] font-medium hover:underline shrink-0">
                Show all jobs →
              </Link>
            </div>
          )}
          <Suspense>
            <JobBoard
              jobs={typedJobs}
              counts={funnelCounts}
              sourceParam={sp.source}
              excludeKeywords={mergedExcludeKeywords}
            />
          </Suspense>
        </div>

        {/* Quick links */}
        <div className="flex items-center gap-3 text-label text-text-3 anim-in anim-delay-3">
          <a href="/api/user/export" className="hover:text-text transition-colors">Export all data</a>
          <span>·</span>
          <Link href="/privacy" className="hover:text-text transition-colors">Privacy policy</Link>
        </div>
      </div>
    </div>
  );
}

/**
 * "Ready to scan" empty state — core setup is done but there are no jobs yet
 * (no search profile created, or all profiles/runs were deleted). Surfaces the
 * one action that produces jobs, with the How-it-works deck below so the empty
 * dashboard teaches instead of sitting blank.
 */
function ReadyToScanScreen({ hasProfiles }: { hasProfiles: boolean }) {
  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <h1 className="text-lead font-semibold text-text">Ready to scan</h1>
        <p className="text-label text-text-2 mt-0.5">
          {hasProfiles
            ? "Your setup is done — run a search profile and your AI-ranked feed appears here."
            : "Your setup is done — create a search profile and your AI-ranked feed appears here."}
        </p>
      </div>

      <div className="px-6 py-8 max-w-5xl mx-auto space-y-8">
        {/* Primary action */}
        <div className="bg-surface border border-border rounded-xl p-6 sm:p-8 text-center anim-in">
          <h2 className="text-h3 font-semibold text-text mb-1.5">
            {hasProfiles ? "Run a scan to fill your feed" : "Create your first search profile"}
          </h2>
          <p className="text-body text-text-2 leading-relaxed mb-5 max-w-md mx-auto">
            {hasProfiles
              ? "You have a search profile but no jobs yet. Run it to pull listings from every source for your keywords + location."
              : "Your job radar: keywords + location + schedule. Save it, then run it — your first AI-scored results land in a minute or two."}
          </p>
          <Link
            href={hasProfiles ? "/profiles" : "/profiles/new"}
            className="gh-btn gh-btn-blue text-title px-5 py-2.5 inline-flex items-center gap-1.5 font-semibold"
          >
            {hasProfiles ? "Go to your profiles" : "Create a search profile"}
          </Link>
          <p className="text-label text-text-3 mt-4">
            Need to change your details?{" "}
            <Link href="/instructions?tab=setup" className="text-[var(--brand)] hover:underline">
              Revisit setup →
            </Link>
          </p>
        </div>

        {/* Educational deck */}
        <div>
          <h2 className="text-body font-semibold text-text mb-3 text-center">How it works</h2>
          <HowItWorksDeck />
        </div>
      </div>
    </div>
  );
}
