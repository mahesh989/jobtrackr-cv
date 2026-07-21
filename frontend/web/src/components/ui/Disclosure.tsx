"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Clickable header row for a collapsible section (Run details, Inject
 * directly, PoolHowItWorks, review-form sections). This is just the header
 * — the caller still owns `{open && <div>...}` for the body, since that
 * varies too much to usefully share. Single source of truth for the
 * chevron-rotate + title/meta layout that was independently reimplemented
 * ~5 times across the app.
 */
export function DisclosureButton({
  open, onToggle, title, subtitle, meta, className = "",
}: {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center justify-between gap-3 px-5 py-3 text-left transition-colors ${className}`.trim()}
    >
      <span className="flex items-center gap-2 min-w-0">
        <ChevronRight
          className={`w-3 h-3 text-text-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0">
          <span className="text-title font-semibold text-text">{title}</span>
          {subtitle && <span className="block text-label text-text-3">{subtitle}</span>}
        </span>
      </span>
      {meta && <span className="shrink-0 flex items-center gap-2 text-caption text-text-3">{meta}</span>}
    </button>
  );
}
