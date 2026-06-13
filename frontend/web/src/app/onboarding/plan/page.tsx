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

        <div className="text-center">
          <h1 className="text-xl font-bold text-text">Start your free trial</h1>
          <p className="mt-1 text-sm text-text-2">3 days free, then A$19.99/month — cancel anytime.</p>
        </div>

        {checkout === "cancelled" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Checkout was cancelled — you haven&apos;t been charged.</span>
          </div>
        )}

        {/* Primary CTA — always Monthly */}
        <TrialHero />

        {/* Plan comparison — informational only, no buttons */}
        <div>
          <p className="mb-3 text-center text-xs text-text-2">
            What&apos;s included in each plan — you can switch anytime after subscribing.
          </p>
          <PlanCards showTrial={false} currentPlan={null} hideButtons />
        </div>

      </div>
    </div>
  );
}
