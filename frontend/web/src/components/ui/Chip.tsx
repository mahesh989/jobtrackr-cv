"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * Selectable filter/toggle pill (toolbar chips, lens pills, profile
 * filters). Single source of truth for the "chip" active/inactive look —
 * change the color scheme here once, every chip in the app follows.
 */
const sizeClass = {
  sm: "px-2.5 py-0.5 text-[11px]",
  md: "px-3 py-1 text-[12px]",
} as const;

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: keyof typeof sizeClass;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(
  ({ active = false, size = "md", className = "", children, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-full font-medium transition-colors shrink-0 whitespace-nowrap ${sizeClass[size]} ${
        active
          ? "bg-[var(--brand)] text-[var(--brand-fg)]"
          : "bg-[var(--surface-2)] border border-[var(--border)] text-text-2 hover:text-text"
      } ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  ),
);
Chip.displayName = "Chip";
