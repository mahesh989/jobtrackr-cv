/**
 * /instructions — the in-app guide, split into two sub-tabs:
 *
 *   How it works  — the educational swipe deck (HowItWorksDeck): key terms +
 *                   the end-to-end pipeline explanation.
 *   Get set up    — the guided wizard: cards while in progress, a clickable
 *                   completed checklist once the required steps are done.
 *
 * Server-rendered. Reachable any time from the sidebar. `?tab=` picks the
 * default sub-tab and `?step=N` opens the wizard on a specific card (used by the
 * SetupStepperBar round-trip).
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { InstructionsTabs } from "@/features/onboarding/InstructionsTabs";
import { HowItWorksDeck } from "@/features/onboarding/HowItWorksDeck";
import { getSetupStatus } from "@/lib/setupStatus";
import { clampStepIndex, firstIncompleteStep, isSetupComplete } from "@/lib/setupSteps";
import { getEntitlement } from "@/lib/billing/entitlements";

export const metadata = { title: "Instructions — JobTrackr" };

export default async function InstructionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; step?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profileRows } = await supabase
    .from("search_profiles").select("id");
  const ids = ((profileRows ?? []) as Array<{ id: string }>).map((p) => p.id);

  const ent = await getEntitlement(user.id);
  const status = await getSetupStatus(user.id, ids, ent.status !== "none");
  const setupComplete = isSetupComplete(status);

  const sp = await searchParams;
  const defaultTab = sp?.tab === "howitworks" ? "howitworks" : "setup";
  const initialStep = sp?.step
    ? clampStepIndex(Number(sp.step))
    : firstIncompleteStep(status);

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-1.5 text-caption text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">Instructions</span>
        </div>
        <h1 className="text-lead font-semibold text-text">Instructions</h1>
        <p className="text-label text-text-2 mt-0.5">
          Get set up, learn the vocabulary, and see how the pipeline works end to end.
        </p>
      </div>

      <div className="px-6 py-6 max-w-5xl mx-auto">
        <InstructionsTabs
          defaultTab={defaultTab}
          setupComplete={setupComplete}
          status={status}
          initialStep={initialStep}
          howItWorks={<HowItWorksDeck />}
        />
      </div>
    </div>
  );
}
