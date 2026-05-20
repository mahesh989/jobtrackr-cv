"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface RunSnapshot {
  id:            string;
  profile_id:    string;
  profile_name:  string;
  status:        "running" | "completed" | "failed";
  current_stage: string | null;
  jobs_saved:    number;
  finished_at:   string | null;
}

interface Toast {
  id:    string;
  kind:  "success" | "error";
  title: string;
  sub:   string;
  href:  string;
}

const POLL_MS  = 3000;
const TOAST_MS = 8000;

export function RunNotifier() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prev   = useRef<Record<string, string>>({});
  const seeded = useRef(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timeoutHandles: ReturnType<typeof setTimeout>[] = [];

    async function poll() {
      try {
        const res = await fetch("/api/user/runs", { cache: "no-store" });
        if (!res.ok) return;
        const { runs }: { runs: RunSnapshot[] } = await res.json();
        if (cancelled) return;

        const next: Record<string, string> = {};
        for (const r of runs) next[r.id] = r.status;

        // First poll: don't fire toasts for transitions we missed before mount.
        if (!seeded.current) {
          prev.current = next;
          seeded.current = true;
          return;
        }

        let anyTransition = false;
        for (const r of runs) {
          const was = prev.current[r.id];
          if (was === "running" && r.status !== "running") {
            anyTransition = true;
            const isSuccess = r.status === "completed";
            const toastId   = `${r.id}:${r.status}`;
            const toast: Toast = {
              id:    toastId,
              kind:  isSuccess ? "success" : "error",
              title: isSuccess
                ? `${r.profile_name} — ${r.jobs_saved} new ${r.jobs_saved === 1 ? "job" : "jobs"}`
                : `${r.profile_name} — pipeline ${r.status}`,
              sub:   isSuccess ? "Click to view feed" : "Click to view run history",
              href:  isSuccess
                ? `/dashboard/profiles/${r.profile_id}/jobs`
                : `/dashboard/profiles/${r.profile_id}/runs`,
            };
            setToasts((t) => (t.some((x) => x.id === toastId) ? t : [...t, toast]));
            const h = setTimeout(() => {
              setToasts((t) => t.filter((x) => x.id !== toastId));
            }, TOAST_MS);
            timeoutHandles.push(h);
          }
        }

        prev.current = next;

        // Trigger a server refresh so the page the user is sitting on
        // updates its server-rendered state (job counts, isRunning, etc.)
        if (anyTransition) router.refresh();
      } catch {
        /* silent */
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const h of timeoutHandles) clearTimeout(h);
    };
  }, [router]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          className={`block w-80 rounded-md border px-4 py-3 shadow-lg anim-in transition-transform hover:-translate-y-0.5 ${
            t.kind === "success"
              ? "border-[#1A7F37]/30 bg-[#DAFBE1] text-[#1A7F37]"
              : "border-[#CF222E]/30 bg-[#FFEBE9] text-[#CF222E]"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {t.kind === "success" ? (
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" />
              </svg>
            )}
            <div className="min-w-0">
              <div className="text-[13px] font-semibold truncate">{t.title}</div>
              <div className="text-[11px] mt-0.5 opacity-80">{t.sub}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
