"use client";

import { useState } from "react";
import { Button } from "@/ui";

/**
 * "Email me when new jobs are found" switch — backed by
 * GET/PATCH /api/user/notifications (user_engagement.notify_new_jobs).
 */
export function NotificationsToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    const next = !enabled;
    setEnabled(next); // optimistic
    setPending(true);
    try {
      const res = await fetch("/api/user/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify_new_jobs: next }),
      });
      if (!res.ok) setEnabled(!next); // revert on failure
    } catch {
      setEnabled(!next);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="default"
      size="sm"
      role="switch"
      aria-checked={enabled}
      onClick={handleToggle}
      disabled={pending}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-[var(--brand)]" : "bg-[var(--border)]"
      } ${pending ? "opacity-60" : ""}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          enabled ? "translate-x-[18px]" : "translate-x-[3px]"
        }`}
      />
    </Button>
  );
}
