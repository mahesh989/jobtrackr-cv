"use client";

/**
 * SetupStepperBar — the guided-setup banner shown on each setup *screen*
 * (profile, CV, voice, integrations, new profile) while the wizard is active.
 *
 * Mounted once in the dashboard layout; renders only when the URL carries
 * `?setup=1&step=N`. "Next" ALWAYS advances to the next step's card — done or
 * not. A step you deliberately leave incomplete (an optional step you choose
 * to skip) must never trap you bouncing between the card and its screen;
 * completion is acknowledged passively via the green check + dot row on the
 * card/checklist, not by blocking forward motion here. "Back" re-shows this
 * step's own card (to re-read it, not to go to the previous step). The last
 * step's button is "Finish setup" — the ONE place setup completion is
 * actually enforced: if a required step is still outstanding it shows an
 * info popup instead of silently redirecting.
 */

import { useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Check, X } from "lucide-react";
import { SETUP_STEPS, SETUP_STEP_COUNT } from "@/lib/setupSteps";
import { Button } from "@/components/ui";

const SETUP_TAB = "/instructions?tab=setup";

export function SetupStepperBar() {
  const params = useSearchParams();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [missing, setMissing]   = useState<string[] | null>(null);
  const [nextStep, setNextStep] = useState(1);

  if (params.get("setup") !== "1") return null;

  const stepNum = Number(params.get("step"));
  if (!Number.isFinite(stepNum) || stepNum < 1 || stepNum > SETUP_STEP_COUNT) return null;

  const idx  = stepNum - 1;
  const step = SETUP_STEPS[idx];
  const isLast = stepNum === SETUP_STEP_COUNT;

  // Next → the next step's card. Back → re-show this step's card.
  const nextHref = `${SETUP_TAB}&step=${stepNum + 1}`;
  const backHref = `${SETUP_TAB}&step=${stepNum}`;

  async function handleFinish() {
    setChecking(true);
    try {
      const res  = await fetch("/api/user/setup-status");
      const data = await res.json() as { complete: boolean; step: number; missingRequired: string[] };
      if (data.complete) {
        router.push(SETUP_TAB);
      } else {
        setNextStep(data.step);
        setMissing(data.missingRequired);
      }
    } catch {
      // Network hiccup — fail open to the checklist rather than trap the user.
      router.push(SETUP_TAB);
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-[var(--brand)]/10 px-6 py-2.5 backdrop-blur">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-label font-medium text-text-2 hover:text-text transition-colors shrink-0"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </Link>

        <div className="flex-1 min-w-0 text-center">
          <span className="text-caption text-text-3">Step {stepNum} of {SETUP_STEP_COUNT} · </span>
          <span className="text-label font-medium text-text">{step.title}</span>
        </div>

        <Button
          variant="blue"
          size="sm"
          onClick={() => isLast ? void handleFinish() : router.push(nextHref)}
          disabled={checking}
          icon={isLast ? <Check className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        >
          {isLast ? (checking ? "Checking…" : "Finish setup") : "Next"}
        </Button>
      </div>

      {missing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal>
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-xl anim-in">
            <div className="flex items-start justify-between gap-2 mb-2">
              <h3 className="text-title font-semibold text-text">Not quite finished</h3>
              <button
                onClick={() => setMissing(null)}
                aria-label="Close"
                className="shrink-0 rounded p-1 text-text-3 hover:text-text hover:bg-[var(--surface-2)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-label text-text-2 mb-3">
              These required steps still need to be done:
            </p>
            <ul className="mb-4 space-y-1">
              {missing.map((title) => (
                <li key={title} className="text-label text-text flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--amber)] shrink-0" /> {title}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setMissing(null)}
                className="text-label text-text-2 hover:text-text transition-colors px-3 py-1.5"
              >
                Not now
              </button>
              <Button
                variant="blue"
                size="sm"
                onClick={() => router.push(`${SETUP_TAB}&step=${nextStep}`)}
              >
                Continue setup
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
