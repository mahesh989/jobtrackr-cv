import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function SectionCard({
  icon: Icon, title, subtitle, children,
}: { icon: React.ElementType; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)]/10 text-[var(--brand)]">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[14.5px] font-semibold text-text">{title}</h2>
          {subtitle && <p className="text-[12px] text-text-3 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function Field({ label, value, onChange, type = "text", placeholder, required = false, invalid = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean; invalid?: boolean }) {
  const border = invalid
    ? "border-red-500 focus:ring-red-500/20"
    : "border-[var(--border)] focus:ring-[var(--brand)]/30";
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
        {invalid && <span className="text-red-600 font-semibold ml-1.5">· required</span>}
      </label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full rounded-md border ${border} bg-[var(--surface)] px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2`} />
    </div>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <div className="select-chevron-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}
          className="select-chevron w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30">
          {options.map((opt) => <option key={opt} value={opt}>{opt || "—"}</option>)}
        </select>
        <ChevronDown className="h-4 w-4 text-text-2" />
      </div>
    </div>
  );
}

export function CheckBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 hover:bg-[var(--surface-2)] transition-colors">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30" />
      <span className="text-sm text-text">{label}</span>
    </label>
  );
}

export function Pill({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={selected
        ? "inline-flex items-center gap-1 rounded-full bg-[var(--brand)] px-3.5 py-1.5 text-sm font-medium text-[var(--brand-fg)] shadow-sm transition-shadow hover:glow-gold"
        : "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-sm font-medium text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors"}>
      {selected && <span aria-hidden>✓</span>}
      {label}
    </button>
  );
}
