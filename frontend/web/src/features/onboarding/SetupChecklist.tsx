/**
 * SetupChecklist — the "all set" view of the Get-set-up tab.
 *
 * A vertical, connected stepper showing every step with its done state. Each
 * row is a link back into that step's screen (in guided mode) so the user can
 * revisit or edit anything. Shown once the required steps are complete.
 */

import Link from "next/link";
import { Check, ChevronRight } from "lucide-react";
import type { SetupStatus } from "@/lib/setupStatus";
import { SETUP_STEPS, TAG_LABEL } from "@/lib/setupSteps";

export function SetupChecklist({ status }: { status: SetupStatus }) {
  const doneCount = SETUP_STEPS.filter((s) => status[s.key]).length;

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="text-center mb-5 anim-in">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-[var(--green-light)] border border-[var(--green)]/30 flex items-center justify-center">
          <Check className="w-6 h-6 text-[var(--green)]" strokeWidth={3} />
        </div>
        <h2 className="text-lead font-semibold text-text">You&apos;re all set</h2>
        <p className="text-label text-text-2 mt-1">
          {doneCount} of {SETUP_STEPS.length} steps done — click any step to review or make changes.
        </p>
      </div>

      <ol className="relative">
        {SETUP_STEPS.map((step, idx) => {
          const Icon = step.icon;
          const done = status[step.key];
          const isLast = idx === SETUP_STEPS.length - 1;
          return (
            <li key={step.key} className="relative pl-12 pb-3 last:pb-0">
              {/* connector line */}
              {!isLast && (
                <span className="absolute left-[15px] top-8 bottom-0 w-px bg-border" aria-hidden />
              )}
              {/* node */}
              <span
                className={
                  "absolute left-0 top-1 w-8 h-8 rounded-full flex items-center justify-center border " +
                  (done
                    ? "bg-[var(--green-light)] border-[var(--green)]/30 text-[var(--green)]"
                    : "bg-[var(--surface-2)] border-border text-text-3")
                }
              >
                {done ? <Check className="w-4 h-4" strokeWidth={3} /> : <Icon className="w-4 h-4" />}
              </span>

              <Link
                href={`${step.href}?setup=1&step=${idx + 1}`}
                className="group flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 hover:border-[var(--brand)]/40 hover:bg-[var(--surface-2)] transition-colors"
              >
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-body font-semibold text-text truncate">{step.title}</span>
                    {!done && (
                      <span className="text-micro text-text-3 uppercase tracking-wide">{TAG_LABEL[step.tag]}</span>
                    )}
                  </span>
                  <span className="block text-caption text-text-3 mt-0.5">
                    {done ? "Done" : "Not done yet"}
                  </span>
                </span>
                <ChevronRight className="w-4 h-4 text-text-3 group-hover:text-[var(--brand)] shrink-0 transition-colors" />
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
