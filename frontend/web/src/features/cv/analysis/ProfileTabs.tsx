"use client";

/**
 * ProfileTabs — three sub-tabs on /dashboard/cv (the "Profile" page):
 *   • CVs         — role type + the CV library
 *   • Details     — contact details, working rights, availability, references
 *   • Credentials — certifications/licences
 *
 * Active tab syncs to ?tab= (shallow, no navigation) so refreshes land on the
 * right tab. Mirrors InstructionsTabs.tsx's pattern.
 */

import { useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui";

type Tab = "cvs" | "details" | "credentials";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "cvs",         label: "CVs" },
  { key: "details",     label: "Details" },
  { key: "credentials", label: "Credentials" },
];

export function ProfileTabs({
  defaultTab,
  cvs,
  details,
  credentials,
}: {
  defaultTab: Tab;
  cvs: ReactNode;
  details: ReactNode;
  credentials: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(defaultTab);

  function select(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  return (
    <Tabs.Root value={tab} onValueChange={select as (v: string) => void}>
      <Tabs.List className="flex items-center gap-1 border-b border-border mb-6">
        {TABS.map((t) => (
          <Tabs.Trigger
            key={t.key}
            value={t.key}
            className="px-4 py-2.5 text-body font-semibold -mb-px"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      <Tabs.Content value="cvs">
        <section className="anim-in space-y-6">{cvs}</section>
      </Tabs.Content>

      <Tabs.Content value="details">
        <section className="anim-in space-y-6">{details}</section>
      </Tabs.Content>

      <Tabs.Content value="credentials">
        <section className="anim-in space-y-6">{credentials}</section>
      </Tabs.Content>
    </Tabs.Root>
  );
}
