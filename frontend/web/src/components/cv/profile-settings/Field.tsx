"use client";

import { ChevronDown } from "lucide-react";

export function Field({
  label, value, onChange, type = "text", placeholder,
}: {
  label:        string;
  value:        string;
  onChange:     (v: string) => void;
  type?:        string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
      />
    </div>
  );
}

export function Select({
  label, value, onChange, options,
}: {
  label:    string;
  value:    string;
  onChange: (v: string) => void;
  options:  string[];
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <div className="select-chevron-wrap">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="select-chevron w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>{opt || "—"}</option>
          ))}
        </select>
        <ChevronDown className="h-4 w-4 text-text-2" />
      </div>
    </div>
  );
}

export function CheckBox({
  label, checked, onChange,
}: {
  label:    string;
  checked:  boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 hover:bg-[var(--surface-2)] transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30"
      />
      <span className="text-sm text-text">{label}</span>
    </label>
  );
}

export function Pill({
  label, selected, onClick,
}: {
  label:    string;
  selected: boolean;
  onClick:  () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        selected
          ? "inline-flex items-center gap-1 rounded-full bg-[var(--brand)] px-3.5 py-1.5 text-sm font-medium text-[var(--brand-fg)] shadow-sm transition-shadow hover:glow-gold"
          : "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-sm font-medium text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors"
      }
    >
      {selected && <span aria-hidden>✓</span>}
      {label}
    </button>
  );
}
