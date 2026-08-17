import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { getEntitlement } from "@/lib/billing/entitlements";
import { PUBLIC_PLANS, formatAud } from "@/lib/billing/plans";
import { TrialHero } from "@/features/billing/TrialHero";
import { PlanCards } from "@/features/billing/PlanCards";
import { Button } from "@/components/ui";

const monthlyPrice = formatAud(PUBLIC_PLANS.find((p) => p.id === "monthly")!.priceCents);

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
    <div className="min-h-screen bg-bg px-4 sm:px-6 py-8">
      <div className="mx-auto max-w-4xl space-y-5">

        <div className="flex justify-end">
          <form action="/auth/signout" method="post">
            <Button size="sm">Sign out</Button>
          </form>
        </div>

        <div className="text-center">
          <h1 className="text-xl font-bold text-text">Start your free trial</h1>
          <p className="mt-1 text-sm text-text-2">3 days free, then {monthlyPrice}/month — cancel anytime.</p>
        </div>

        {checkout === "cancelled" && (
          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle px-4 py-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Checkout was cancelled — you haven&apos;t been charged.</span>
          </div>
        )}

        {/* Primary CTA — always Monthly */}
        <TrialHero />

        {/* Plan comparison — each card is directly selectable. Buttons name
            the plan ("Choose Weekly") rather than repeating a trial CTA on
            every card; TrialHero above is the one clear trial CTA, and the
            trial applies to whichever plan you pick either way (explained in
            the line below). showTrial=false hides the trial footnote too. */}
        <div>
          <p className="mb-3 text-center text-xs text-text-2">
            Or pick a different plan below — every plan starts with the same free trial.
          </p>
          <PlanCards showTrial={false} currentPlan={null} />
        </div>

      </div>
    </div>
  );
}
