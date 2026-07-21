"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * A single row in a dropdown/context menu (CardMenu, overflow menus). Full
 * width, plain — the menu's own container owns the border/shadow/positioning.
 * Single source of truth for menu-row styling; a menu with more rows never
 * ends up a different rendered width than one with fewer.
 */
export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Destructive action (Archive, Delete, Dismiss) — red on hover instead of the default text color. */
  danger?: boolean;
}

/**
 * The row className itself, exported so a Link/`<a>` row in the same menu
 * (navigational items sitting next to action items — see PoolOverflowMenu)
 * can match a `<MenuItem>` exactly without a second copy of this string to
 * keep in sync by hand.
 */
export function menuItemClass(danger = false, className = ""): string {
  return `w-full flex items-center gap-2 text-left px-3 py-1.5 text-label transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-40 ${
    danger ? "text-text-3 hover:text-red-600" : "text-text-2 hover:text-text"
  } ${className}`.trim();
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  ({ danger = false, className = "", disabled, children, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={menuItemClass(danger, className)}
      {...rest}
    >
      {children}
    </button>
  ),
);
MenuItem.displayName = "MenuItem";
