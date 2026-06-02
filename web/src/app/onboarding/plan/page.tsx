import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { getEntitlement } from "@/lib/billing/entitlements";
import { TrialHero } from "@/components/billing/TrialHero";
import { PlanCards } from "@/components/billing/PlanCards";

export const metadata = { title: "Start your free trial — JobTrackr" };

export default async function OnboardingPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { checkout } = await searchParams;
  const ent = await getEntitlement(user.id);

  if (ent.access === "full") redirect("/dashboard");

  return (
    <div className="min-h-screen bg-bg px-6 py-8">
      <div className="mx-auto max-w-4xl space-y-5">

        {/* Page header */}
        <div className="text-center">
          <h1 className="text-xl font-bold text-text">Choose your plan</h1>
          <p className="mt-1 text-sm text-text-2">Start with a 3-day free trial — cancel anytime before it ends.</p>
        </div>

        {checkout === "cancelled" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Checkout was cancelled — you haven&apos;t been charged. Start your trial whenever you&apos;re ready.</span>
          </div>
        )}

        {/* Compact trial banner */}
        <TrialHero />

        {/* Plan cards */}
        <PlanCards showTrial={false} currentPlan={null} />

      </div>
    </div>
  );
}
