"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui";

/**
 * Shown on the profiles list when the user has any profile_pause_state rows
 * (auto-paused by the worker gate — 30-day inactivity or a dead subscription).
 * Resume is always an explicit user action — profiles never auto-resume.
 */
export function ResumePausedBanner({ count }: { count: number }) {
  const [pending, setPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();

  if (dismissed || count === 0) return null;

  async function handleResume() {
    setPending(true);
    try {
      const res = await fetch("/api/profiles/resume-paused", { method: "POST" });
      if (res.ok) {
        setDismissed(true);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <p className="text-[13px] text-amber-900 dark:text-amber-200">
        Automatic job fetching was paused for {count} profile{count === 1 ? "" : "s"} while you were away.
      </p>
      <Button
        onClick={handleResume}
        disabled={pending}
        size="sm"
        className="px-3 py-1.5 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/20 shrink-0"
      >
        {pending ? "Resuming…" : "Resume"}
      </Button>
    </div>
  );
}
