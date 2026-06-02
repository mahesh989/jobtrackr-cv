import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Sparkles, AlertTriangle } from "lucide-react";
import { getEntitlement } from "@/lib/billing/entitlements";
import { PlanCards } from "@/components/billing/PlanCards";

export const metadata = { title: "Choose your plan — JobTrackr" };

/**
 * Plan-selection gate. New users land here after signup (and after a cancelled
 * Stripe Checkout) to start their trial. If they already have write access we
 * bounce them into the dashboard — no need to pick a plan again.
 */
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
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--brand)]/10">
            <Sparkles className="h-6 w-6 text-[var(--brand)]" />
          </div>
          <h1 className="text-2xl font-bold text-text">Start your free trial</h1>
          <p className="mt-2 text-sm text-text-2">
            Pick a plan to unlock job discovery and CV tailoring. Your 3-day trial includes
            3 tailored CVs and 3 cover letters — cancel anytime before it ends.
          </p>
        </div>

        {checkout === "cancelled" && (
          <div className="mx-auto flex max-w-xl items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Checkout was cancelled — you haven&apos;t been charged. Choose a plan whenever you&apos;re ready.</span>
          </div>
        )}

        <PlanCards showTrial currentPlan={null} />

        <p className="text-center text-xs text-text-2">
          Bring your own AI key — JobTrackr never charges for AI tokens.
        </p>
      </div>
    </div>
  );
}
