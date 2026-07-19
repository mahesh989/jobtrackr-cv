"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { Tabs } from "@/components/ui";

/**
 * 2-tab Applications flow:
 *   pool — every job with a completed cover letter that hasn't been applied
 *          or dismissed yet. Triage + review + send happens here on the same
 *          card. Filter: !applied_at && !dismissed_at.
 *   sent — applied_at IS NOT NULL.
 *
 * Archive: removes the card from this screen entirely. Archived jobs live in
 * the dashboard / per-profile archive view, NOT here.
 */
export type ApplicationStatusKey = "pool" | "sent";

export interface ApplicationStatusCounts {
  pool: number;
  sent: number;
}

const TABS: Array<{ value: ApplicationStatusKey; label: string }> = [
  { value: "pool", label: "Application pool" },
  { value: "sent", label: "Sent / Applied"   },
];

export function StatusTabs({ counts }: { counts: ApplicationStatusCounts }) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [, startTransition] = useTransition();

  const current = (sp.get("status") as ApplicationStatusKey) || "pool";

  function setTab(v: ApplicationStatusKey) {
    const params = new URLSearchParams(sp.toString());
    if (v === "pool") params.delete("status"); else params.set("status", v);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  return (
    <Tabs.Root value={current} onValueChange={setTab as (v: string) => void}>
      <Tabs.List className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-0.5 w-fit">
        {TABS.map((t) => {
          const count = counts[t.value];
          return (
            <Tabs.Trigger
              key={t.value}
              value={t.value}
              className={
                "inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium whitespace-nowrap border-b-0 " +
                (current === t.value
                  ? "bg-[var(--surface)] text-text shadow-sm border border-[var(--border)]"
                  : "text-text-2 hover:text-text border-transparent")
              }
            >
              {t.label}
              {count > 0 && (
                <span
                  className={
                    "text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center " +
                    (current === t.value
                      ? "bg-text text-[var(--surface)]"
                      : "bg-[var(--border)] text-text-2")
                  }
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}
