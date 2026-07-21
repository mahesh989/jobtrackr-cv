"use client";

import type { ReactNode } from "react";

/**
 * SaveBar — the autosave status footer for Pattern B editors (mirrors
 * .save-bar in form-patterns.html): a surface-2 strip with a state dot, a
 * status message, and an optional trailing action (usually an explicit Save
 * button). Generic and props-driven so every autosave surface — CV profile
 * sections, the structured review editor, cover-letter text — shares one
 * dot/colour/layout instead of re-implementing it.
 */
export type SaveState = "idle" | "dirty" | "saving" | "saved";

const DOT: Record<SaveState, string> = {
  idle:   "bg-[var(--text-3)]",
  dirty:  "bg-[var(--amber)]",
  saving: "bg-[var(--brand)] animate-pulse",
  saved:  "bg-[var(--green)]",
};

export function SaveBar({
  state = "idle", message, action, className = "",
}: {
  state?: SaveState;
  message?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2.5 rounded-b-lg border-t border-border bg-[var(--surface-2)] px-4 py-3 ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${DOT[state]}`} />
      {message ? <span className="text-caption text-text-2">{message}</span> : null}
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}
