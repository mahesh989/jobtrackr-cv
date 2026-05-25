"use client";

/**
 * InstructionsTabs — two sub-tabs on /dashboard/instructions:
 *   • Get set up   — the guided wizard (cards while in progress, checklist once done)
 *   • How it works — key terms + the end-to-end pipeline explanation
 *
 * The "How it works" panel is rendered on the server and handed in as a node so
 * its content stays server-rendered. The active tab syncs to ?tab= so refreshes
 * and the stepper bar's "Finish setup" link land on the right tab.
 */

import { useState, type ReactNode } from "react";
import type { SetupStatus } from "@/lib/setupStatus";
import { SetupCards } from "./SetupCards";
import { SetupChecklist } from "./SetupChecklist";

type Tab = "setup" | "howitworks";

export function InstructionsTabs({
  defaultTab,
  setupComplete,
  status,
  initialStep,
  howItWorks,
}: {
  defaultTab: Tab;
  setupComplete: boolean;
  status: SetupStatus;
  initialStep: number;
  howItWorks: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(defaultTab);

  function select(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    if (next !== "setup") url.searchParams.delete("step");
    window.history.replaceState(null, "", url);
  }

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "howitworks", label: "How it works" },
    { key: "setup",      label: "Get set up" },
  ];

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border mb-6">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => select(t.key)}
            className={
              "relative px-4 py-2.5 text-[13px] font-semibold transition-colors -mb-px border-b-2 " +
              (tab === t.key
                ? "text-[var(--brand)] border-[var(--brand)]"
                : "text-text-2 border-transparent hover:text-text")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panels */}
      {tab === "setup" ? (
        <section className="anim-in">
          {setupComplete
            ? <SetupChecklist status={status} />
            : <SetupCards status={status} initialStep={initialStep} />}
        </section>
      ) : (
        <section className="anim-in">{howItWorks}</section>
      )}
    </div>
  );
}
