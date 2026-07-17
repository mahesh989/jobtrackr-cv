"use client";

/**
 * SetupStepperBar — the guided-setup banner shown on each setup *screen*
 * (profile, CV, voice, integrations, new profile) while the wizard is active.
 *
 * Mounted once in the dashboard layout; renders only when the URL carries
 * `?setup=1&step=N`. It drives the FORWARD flow: after finishing the task on
 * this screen the user clicks the dominant "Next" to advance to the next
 * step's *card* (back on the instructions tab). "Back" is an optional escape
 * to re-read this step's card. The last step shows "Finish setup".
 */

import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import { SETUP_STEPS, SETUP_STEP_COUNT } from "@/lib/setupSteps";
import { Button } from "@/ui";

const SETUP_TAB = "/dashboard/instructions?tab=setup";

export function SetupStepperBar() {
  const params = useSearchParams();
  const router = useRouter();

  if (params.get("setup") !== "1") return null;

  const stepNum = Number(params.get("step"));
  if (!Number.isFinite(stepNum) || stepNum < 1 || stepNum > SETUP_STEP_COUNT) return null;

  const idx  = stepNum - 1;
  const step = SETUP_STEPS[idx];
  const isLast = stepNum === SETUP_STEP_COUNT;

  // Next → the next step's card (or finish → the completed checklist).
  const nextHref = isLast ? SETUP_TAB : `${SETUP_TAB}&step=${stepNum + 1}`;
  // Back → re-show this step's card on the instructions tab.
  const backHref = `${SETUP_TAB}&step=${stepNum}`;

  return (
    <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-[var(--brand)]/10 px-6 py-2.5 backdrop-blur">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-text-2 hover:text-text transition-colors shrink-0"
      >
        <ChevronLeft className="w-3.5 h-3.5" /> Back
      </Link>

      <div className="flex-1 min-w-0 text-center">
        <span className="text-[11px] text-text-3">Step {stepNum} of {SETUP_STEP_COUNT} · </span>
        <span className="text-[12px] font-medium text-text">{step.title}</span>
      </div>

      <Button
        variant="blue"
        size="sm"
        onClick={() => router.push(nextHref)}
        icon={isLast ? <Check className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      >
        {isLast ? "Finish setup" : "Next"}
      </Button>
    </div>
  );
}
