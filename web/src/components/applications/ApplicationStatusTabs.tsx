"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

export type ApplicationStatusKey = "pool" | "email" | "apply" | "sent" | "archived";

export interface ApplicationStatusCounts {
  pool:     number;
  email:    number;
  apply:    number;
  sent:     number;
  archived: number;
}

// Tab semantics (post-039 + Review->Send unification):
//   pool     — cover letter just generated; user accepts ("Queue for review")
//              or archives. Contact email is optional here.
//   email    — Review stage. Every queued card is reviewed here regardless of
//              whether a contact email is on file. The tab label is "Ready to
//              review" — kept "email" as the URL/key for backward compat.
//   apply    — Action stage. Reviewed cards land here. Email-channel cards
//              show Send email; no-email cards show Copy email + Apply now.
const TABS: Array<{ value: ApplicationStatusKey; label: string }> = [
  { value: "pool",     label: "Application pool" },
  { value: "email",    label: "Ready to review"  },
  { value: "apply",    label: "Ready to apply"   },
  { value: "sent",     label: "Sent / Applied"   },
  { value: "archived", label: "Archived"         },
];

export function ApplicationStatusTabs({ counts }: { counts: ApplicationStatusCounts }) {
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
