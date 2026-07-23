"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Icon-only action button — star/favourite toggles, "×" close/dismiss,
 * "···" menu triggers, chevron remove buttons. Composed entirely from
 * Tailwind utilities (no shared unlayered CSS class like .gh-btn).
 *
 * NOTE: className can safely ADD non-conflicting utilities (margin,
 * responsive display, etc.) but cannot reliably OVERRIDE a property this
 * component already sets (radius, size, color) — two same-property
 * Tailwind utility classes in one className resolve by Tailwind's own
 * internal stylesheet order, not by their order in the string, so the
 * "later" one in your JSX is not guaranteed to win. That's what `shape`,
 * `size`, and `variant` are for — pick the matching one instead of trying
 * to override.
 */
const variantClass = {
  ghost:   "text-text-3 hover:text-text hover:bg-[var(--surface-2)]",
  outline: "border border-border bg-surface text-text-2 hover:text-text hover:bg-[var(--surface-2)]",
  /** Remove/delete actions — same idle look as ghost, red on hover. */
  danger:  "text-text-3 hover:text-red-500 hover:bg-[var(--surface-2)]",
} as const;

const sizeClass = {
  sm: "w-6 h-6",
  md: "w-7 h-7",
  lg: "w-9 h-9",
} as const;

const shapeClass = {
  rounded: "rounded-md",
  circle:  "rounded-full",
} as const;

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  variant?: keyof typeof variantClass;
  size?: keyof typeof sizeClass;
  shape?: keyof typeof shapeClass;
  /** Required — icon-only buttons have no visible text, so this is the
   *  accessible name. Pass the same string you'd use for `title`. */
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, variant = "ghost", size = "md", shape = "rounded", className = "", disabled, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={`inline-flex items-center justify-center shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${sizeClass[size]} ${shapeClass[shape]} ${variantClass[variant]} ${className}`.trim()}
      {...rest}
    >
      {icon}
    </button>
  ),
);
IconButton.displayName = "IconButton";
