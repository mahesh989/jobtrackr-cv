import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/features/auth/server";
import { ADMIN_ROLES } from "@/lib/constants";
import { ThemeProvider, RunNotifier, SetupGateClient } from "@/components/providers";
import { SetupStepperBar } from "@/features/onboarding/SetupStepperBar";
import { getEntitlement } from "@/lib/billing/entitlements";
import { Sidebar } from "@/components/navigation/Sidebar";
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
  if (ent.status === "none") redirect("/onboarding/plan");

  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(ent.role);
  const userView = isAdmin && (await cookies()).get("jt_user_view")?.value === "1";

  return (
    <ThemeProvider>
    <div className="flex h-screen overflow-hidden bg-[var(--sidebar-bg)]">
      {/* Sidebar — width reserved via min-width to prevent CLS.
          Content streams in via Suspense while page renders immediately. */}
      <div className="shrink-0 hidden md:block" style={{ minWidth: "var(--sidebar-width)" }}>
        <Suspense fallback={null}>
          <Sidebar
            userId={user.id}
            email={user.email!}
            role={ent.role}
            userView={userView}
          />
        </Suspense>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg overflow-y-auto">
        <Header />

        <Suspense fallback={null}>
          <SetupStepperBar />
        </Suspense>

        {/* Client-side setup gate — checks profile + CV + AI key via API.
            Runs in useEffect so the page header (LCP) paints immediately.
            Redirect fires ~200-400ms later if setup is incomplete. */}
        {!isAdmin && <SetupGateClient />}

        {children}
      </div>
      <RunNotifier />
    </div>
    </ThemeProvider>
  );
}
