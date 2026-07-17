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
import { Tabs } from "@/ui";

type Tab = "setup" | "howitworks";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "howitworks", label: "How it works" },
  { key: "setup",      label: "Get set up" },
];

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

  return (
    <Tabs.Root value={tab} onValueChange={select as (v: string) => void}>
      <Tabs.List className="flex items-center gap-1 border-b border-border mb-6">
        {TABS.map((t) => (
          <Tabs.Trigger
            key={t.key}
            value={t.key}
            className="px-4 py-2.5 text-[13px] font-semibold -mb-px"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      <Tabs.Content value="setup">
        <section className="anim-in">
          {setupComplete
            ? <SetupChecklist status={status} />
            : <SetupCards status={status} initialStep={initialStep} />}
        </section>
      </Tabs.Content>

      <Tabs.Content value="howitworks">
        <section className="anim-in">{howItWorks}</section>
      </Tabs.Content>
    </Tabs.Root>
  );
}
