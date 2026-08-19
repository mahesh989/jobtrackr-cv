"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { triggerReanalyze } from "@/lib/analyzeJob";
import { IconButton, MenuItem } from "@/components/ui";
import type { BoardJob } from "../lib/jobFilters";

export function CardMenu({
  job, onDismiss, onEdit, pending,
}: {
  job:       BoardJob;
  onDismiss: () => void;
  onEdit:    () => void;
  pending:   boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [reanalysePending, setReanalysePending] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((v) => !v);
  }
  useEffect(() => {
    if (!open) return;
    function onAway(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onAway);
    return () => document.removeEventListener("mousedown", onAway);
  }, [open]);

  return (
    <>
      <IconButton
        ref={btnRef}
        onClick={toggle}
        disabled={pending}
        aria-label="More actions"
        size="sm"
        icon={<MoreHorizontal className="w-[15px] h-[15px]" />}
      />
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, right: pos.right }}
          className="z-50 min-w-[160px] rounded-md border border-border bg-surface shadow-lg py-1 text-label"
        >
          <MenuItem onClick={() => { setOpen(false); onEdit(); }}>Edit JD…</MenuItem>
          {job.progress.has_analysis && job.progress.latest_run_id && (
            <MenuItem
              onClick={async () => {
                setOpen(false);
                if (reanalysePending) return;
                setReanalysePending(true);
                try {
                  const run_id = await triggerReanalyze(job.id);
                  router.push(`/jobs/${job.id}/analyze/${run_id}`);
                } catch (e) {
                  // C67: was silently ignored — the menu item just reverted
                  // from "Starting…" back to "Re-analyze" with zero
                  // indication anything went wrong. Matches the error
                  // handling DetailHeader.tsx's own onReanalyze already
                  // does for the same triggerReanalyze() call.
                  window.alert(e instanceof Error ? e.message : "Could not start re-analysis. Please try again.");
                } finally { setReanalysePending(false); }
              }}
              disabled={reanalysePending}
            >
              {reanalysePending ? "Starting…" : "Re-analyze"}
            </MenuItem>
          )}
          <MenuItem onClick={() => { setOpen(false); onDismiss(); }}>Dismiss</MenuItem>
        </div>,
        document.body,
      )}
    </>
  );
}
