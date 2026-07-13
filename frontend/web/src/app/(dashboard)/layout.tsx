import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/modules/auth/server";
import { ADMIN_ROLES } from "@/lib/constants";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RunNotifier } from "@/components/RunNotifier";
import { SetupStepperBar } from "@/components/onboarding/SetupStepperBar";
import { getEntitlement } from "@/lib/billing/entitlements";
import { getSetupStatus } from "@/lib/setupStatus";
import { isSetupComplete, firstIncompleteStep } from "@/lib/setupSteps";
import { SidebarData } from "@/components/SidebarData";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  void createClient().then((s) =>
    s.rpc("touch_user_engagement").then(({ error }) => {
      if (error) console.error("[layout] touch_user_engagement failed:", error.message);
    }),
  );

  const ent = await getEntitlement(user.id);
  if (ent.status === "none") redirect("/onboarding/plan");

  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(ent.role);

  // Fetch profile IDs once — used by both the setup gate and sidebar data.
  // Moved before the gate check so we avoid a duplicate search_profiles query.
  const supabase = await createClient();
  const { data: profileIdRows } = await supabase
    .from("search_profiles")
    .select("id")
    .order("created_at", { ascending: true });
  const profileIds = ((profileIdRows ?? []) as { id: string }[]).map((p) => p.id);

  // Setup gate — uses the profile IDs already fetched above.
  // Runs BEFORE the sidebar Suspense so redirects happen immediately.
  const pathname = (await headers()).get("x-pathname") ?? "";
  if (!isAdmin && !pathname.startsWith("/dashboard/instructions")) {
    const setupStatus = await getSetupStatus(user.id, profileIds, true);
    if (!isSetupComplete(setupStatus)) {
      const step = firstIncompleteStep(setupStatus) + 1;
      redirect(`/dashboard/instructions?tab=setup&setup=1&step=${step}`);
    }
  }

  const userView = isAdmin && (await cookies()).get("jt_user_view")?.value === "1";

  return (
    <ThemeProvider>
    <div className="flex h-screen overflow-hidden bg-[var(--sidebar-bg)]">
      {/* Sidebar — streams in via Suspense while page content renders immediately.
          Pool count (expensive 3-step join) loads independently inside SidebarData. */}
      <Suspense fallback={null}>
        <SidebarData
          userId={user.id}
          email={user.email!}
          profileIds={profileIds}
          role={ent.role}
          userView={userView}
        />
      </Suspense>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg overflow-y-auto">
        <div className="md:hidden flex items-center gap-3 px-4 h-12 border-b border-border bg-surface shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wordmark.png" alt="JobTrackr" className="h-6 w-auto object-contain" />
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
