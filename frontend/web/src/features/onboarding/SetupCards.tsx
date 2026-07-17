"use client";

/**
 * SetupCards — the "Get set up" wizard, one explanation card at a time.
 *
 * Flow: read the card → press the dominant "Next" → land on that step's
 * screen (carrying ?setup=1&step=N so SetupStepperBar appears there) → finish
 * the task → the screen's "Next" brings you to the next card. "Back" steps to
 * the previous card (non-destructive). A green check marks steps already done.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { SetupStatus } from "@/lib/setupStatus";
import { SETUP_STEPS, SETUP_STEP_COUNT, TAG_LABEL, type SetupTag } from "@/lib/setupSteps";
import { Button } from "@/ui";

const TAG_CLASS: Record<SetupTag, string> = {
  required:    "text-[var(--brand)] bg-[var(--brand)]/10 border-[var(--brand)]/20",
  recommended: "text-[var(--amber)] bg-[var(--amber-light)] border-[var(--amber)]/30",
  optional:    "text-text-2 bg-[var(--surface-2)] border-border",
};

export function SetupCards({
  status,
  initialStep = 0,
}: {
  status: SetupStatus;
  /** Zero-based card to open on first render (and on each soft-nav back). */
  initialStep?: number;
}) {
  const [i, setI] = useState(initialStep);

  // The instructions page re-renders with a fresh initialStep when the stepper
  // bar navigates back to a card; keep the visible card in sync across that
  // soft-navigation (useState only reads initialStep on first mount).
  // Compared during render (React's "adjusting state when a prop changes"
  // pattern) rather than in an effect.
  const [prevInitialStep, setPrevInitialStep] = useState(initialStep);
  if (prevInitialStep !== initialStep) {
    setPrevInitialStep(initialStep);
    setI(initialStep);
  }

  const router = useRouter();
  const step = SETUP_STEPS[i];
  const Icon = step.icon;
  const done = status[step.key];
  const doneCount = SETUP_STEPS.filter((s) => status[s.key]).length;

  // Dominant CTA → this step's screen, in guided-setup mode.
  const ctaHref = `${step.href}?setup=1&step=${i + 1}`;

  return (
    <div className="w-full max-w-xl mx-auto">
      {/* Progress summary */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] text-text-3">Step {i + 1} of {SETUP_STEP_COUNT}</span>
        <span className="text-[12px] text-text-3">{doneCount}/{SETUP_STEP_COUNT} done</span>
      </div>

      {/* Card */}
      <div className="bg-surface border border-border rounded-xl p-6 sm:p-8 text-center anim-in">
        <div className="relative w-14 h-14 mx-auto mb-5">
          <div className="w-14 h-14 rounded-xl bg-[var(--brand)]/10 border border-[var(--brand)]/20 flex items-center justify-center">
            <Icon className="w-7 h-7 text-[var(--brand)]" />
          </div>
          {done && (
            <span className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-[var(--green)] border-2 border-surface flex items-center justify-center">
              <Check className="w-3.5 h-3.5 text-surface" strokeWidth={3} />
            </span>
          )}
        </div>

        <h2 className="text-[18px] font-semibold text-text mb-2">{step.title}</h2>

        <div className="flex items-center justify-center gap-2 mb-4">
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${TAG_CLASS[step.tag]}`}>
            {TAG_LABEL[step.tag]}
          </span>
          {done && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border text-[var(--green)] bg-[var(--green-light)] border-[var(--green)]/30">
              Done
            </span>
          )}
        </div>

        <p className="text-[13px] text-text-2 leading-relaxed mb-6 max-w-md mx-auto">{step.blurb}</p>

        <Button
          variant="blue"
          className="text-[14px] px-5 py-2.5"
          onClick={() => router.push(ctaHref)}
          icon={<ChevronRight className="w-4 h-4" />}
        >
          {done ? "Review / edit" : "Next"}
        </Button>
      </div>

      {/* Footer nav — Back to the previous card, dot row to jump */}
      <div className="flex items-center justify-between mt-4">
        <Button
          onClick={() => setI((n) => Math.max(0, n - 1))}
          disabled={i === 0}
          className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </Button>

        <div className="flex items-center gap-1.5">
          {SETUP_STEPS.map((s, idx) => (
            <Button
              key={s.key}
              onClick={() => setI(idx)}
              aria-label={`Go to step ${idx + 1}: ${s.title}`}
              className={
                "h-2 rounded-full transition-all " +
                (idx === i ? "w-5 bg-[var(--brand)]" : "w-2 ") +
                (idx !== i ? (status[s.key] ? "bg-[var(--green)]" : "bg-border hover:bg-text-3") : "")
              }
            />
          ))}
        </div>

        <Button
          onClick={() => setI((n) => Math.min(SETUP_STEP_COUNT - 1, n + 1))}
          disabled={i === SETUP_STEP_COUNT - 1}
          className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Skip <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
