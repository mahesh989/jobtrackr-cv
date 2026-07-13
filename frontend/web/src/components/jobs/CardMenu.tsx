"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { triggerReanalyze } from "@/components/cv/AnalyzeJobButton";
import type { BoardJob } from "./jobFilters";

function MenuItem({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-2)] disabled:text-text-3 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

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
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-label="More actions"
        className="p-1 rounded hover:bg-[var(--surface-2)] text-text-3 disabled:opacity-40"
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, right: pos.right }}
          className="z-50 min-w-[160px] rounded-md border border-border bg-surface shadow-lg py-1 text-[12px]"
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
                  router.push(`/dashboard/jobs/${job.id}/analyze/${run_id}`);
                } catch { /* ignore */ } finally { setReanalysePending(false); }
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
