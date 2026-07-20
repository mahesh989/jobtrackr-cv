"use client";

import type { ReactNode } from "react";

/**
 * Grouped option-switcher on a shared pill-tray background (density picker,
 * section tabs). Single source of truth for that "one active pill inside a
 * tray" look — distinct from Chip (independent pills, multi-select-shaped)
 * and from Tabs (underline style, URL/route-driven).
 */
export interface SegmentedOption<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
}

const outerSizeClass = {
  sm: "rounded-lg p-0.5 gap-1",
  md: "rounded-xl p-1 gap-1",
} as const;

const optionSizeClass = {
  sm: "px-2.5 py-1 rounded text-[11px]",
  md: "px-4 py-2 rounded-lg text-[13px]",
} as const;

export function SegmentedControl<T extends string>({
  options, value, onChange, size = "md", brandActive = false, className = "",
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: keyof typeof outerSizeClass;
  /** Active option's text takes the theme's brand color instead of plain text. */
  brandActive?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center bg-[var(--surface-2)] border border-[var(--border)] w-fit ${outerSizeClass[size]} ${className}`.trim()}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            title={opt.title}
            className={`inline-flex items-center gap-1.5 font-medium whitespace-nowrap transition-all ${optionSizeClass[size]} ${
              active
                ? `bg-[var(--surface)] shadow-sm ${brandActive ? "text-[var(--brand)]" : "text-text"}`
                : "text-text-2 hover:text-text"
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
