import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/features/auth/server";
import { ADMIN_ROLES } from "@/lib/constants";
import { ThemeProvider, RunNotifier, SetupGateClient } from "@/components/providers";
import { SetupStepperBar } from "@/features/onboarding";
import { getEntitlement } from "@/lib/billing/entitlements";
import { Sidebar } from "@/components/navigation/Sidebar";
import { ResizableSidebar } from "@/components/navigation/ResizableSidebar";
import { Header } from "@/components/navigation/Header";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  void createClient().then((s) =>
    s.rpc("touch_user_engagement").then(({ error }) => {
      if (error) console.error("[layout] touch_user_engagement failed:", error.message);
    }),
  );

  const ent = await getEntitlement(user.id);
  // Never-subscribed accounts stay on the plan page until they pick a plan
  // (paid or trial). "incomplete"/"incomplete_expired" = checkout started but
  // never activated — still never-subscribed. Former subscribers (canceled /
  // unpaid) keep read-only dashboard access to their existing data instead.
  if (["none", "incomplete", "incomplete_expired"].includes(ent.status)) {
    redirect("/onboarding/plan");
  }

  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(ent.role);
  const userView = isAdmin && (await cookies()).get("jt_user_view")?.value === "1";

  return (
    <ThemeProvider>
    <div className="flex h-screen overflow-hidden bg-[var(--sidebar-bg)]">
      {/* Sidebar — desktop width is user-resizable (ResizableSidebar owns the
          width; the main column flexes via flex-1). Content streams in via
          Suspense while the page renders immediately. */}
      <ResizableSidebar>
        <Suspense fallback={null}>
          <Sidebar
            userId={user.id}
            email={user.email!}
            role={ent.role}
            userView={userView}
          />
        </Suspense>
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 bg-sidebar-bg overflow-y-auto">
        <Header />

        <Suspense fallback={null}>
          <SetupStepperBar />
        </Suspense>

        {/* Client-side setup gate — checks profile + CV + AI key via API.
            Runs in useEffect so the page header (LCP) paints immediately.
            Redirect fires ~200-400ms later if setup is incomplete. */}
        {!isAdmin && <Suspense fallback={null}><SetupGateClient /></Suspense>}

        {children}
      </div>
      <RunNotifier isAdmin={isAdmin} />
    </div>
    </ThemeProvider>
  );
}
