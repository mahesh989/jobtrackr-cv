"use client";

/**
 * Status tabs for /dashboard/applications.
 *
 * Four mutually-exclusive lifecycle buckets, URL-encoded as ?status=…:
 *   - email      : has completed cover letter + has_email   + not applied + not archived
 *   - apply      : has completed cover letter + no email    + not applied + not archived
 *   - sent       : applied_at IS NOT NULL                      (any channel)
 *   - archived   : dismissed_at IS NOT NULL                    (whether applied or not)
 *
 * Default tab when no ?status= is set: "email" (the highest-leverage bucket).
 * Reuses the same URL-param + useTransition pattern as JobStatusTabs.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

export type ApplicationStatusKey = "email" | "apply" | "sent" | "archived";

export interface ApplicationStatusCounts {
  email:    number;
  apply:    number;
  sent:     number;
  archived: number;
}

const TABS: Array<{ value: ApplicationStatusKey; label: string }> = [
  { value: "email",    label: "Ready to email" },
  { value: "apply",    label: "Ready to apply" },
  { value: "sent",     label: "Sent / Applied" },
  { value: "archived", label: "Archived"       },
];

export function ApplicationStatusTabs({ counts }: { counts: ApplicationStatusCounts }) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [, startTransition] = useTransition();

  const current = (sp.get("status") as ApplicationStatusKey) || "email";

  function setTab(v: ApplicationStatusKey) {
    const params = new URLSearchParams(sp.toString());
    if (v === "email") params.delete("status"); else params.set("status", v);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  return (
    <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-0.5 w-fit">
      {TABS.map((t) => {
        const active = current === t.value;
        const count  = counts[t.value];
        return (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all whitespace-nowrap ${
              active
                ? "bg-[var(--surface)] text-text shadow-sm border border-[var(--border)]"
                : "text-text-2 hover:text-text"
            }`}
          >
            {t.label}
            {count > 0 && (
              <span
                className={
                  "text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center " +
                  (active ? "bg-text text-[var(--surface)]" : "bg-[var(--border)] text-text-2")
                }
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
