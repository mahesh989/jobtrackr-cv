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

  // Already entitled → straight to the dashboard.
  if (ent.access === "full") redirect("/dashboard");

  return (
    <div className="min-h-screen bg-bg px-6 py-12">
      <div className="mx-auto max-w-4xl space-y-10">

        {checkout === "cancelled" && (
          <div className="mx-auto flex max-w-xl items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Checkout was cancelled — you haven&apos;t been charged. Start your trial whenever you&apos;re ready.</span>
          </div>
        )}

        {/* Primary trial CTA — defaults to Monthly */}
        <TrialHero />

        {/* Divider */}
        <div className="flex items-center gap-4">
          <div className="flex-1 border-t border-border" />
          <span className="text-xs text-text-2">or compare all plans</span>
          <div className="flex-1 border-t border-border" />
        </div>

        {/* Full plan comparison */}
        <PlanCards showTrial={false} currentPlan={null} />

      </div>
    </div>
  );
}
