"use client";

import { useState } from "react";
import { ToggleSwitch } from "@/components/ui";

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

  return <ToggleSwitch checked={enabled} onChange={handleToggle} disabled={pending} />;
}
