import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui";
import { FieldLabel } from "@/lib/field-utils";

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
  // Routes through the shared field SSOT (.field + FieldLabel) so these
  // Details/Credentials fields match every other form in the app.
  return (
    <div>
      <FieldLabel required={required}>
        {label}
        {invalid && <span className="text-[var(--red)] font-semibold ml-1.5">· required</span>}
      </FieldLabel>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`field ${invalid ? "border-[var(--red)]" : ""}`} />
    </div>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="select-chevron-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)} className="field select-chevron">
          {options.map((opt) => <option key={opt} value={opt}>{opt || "—"}</option>)}
        </select>
        <ChevronDown className="h-4 w-4 text-text-2" />
      </div>
    </div>
  );
}

export function CheckBox({ label, checked, onChange, detected = false }: { label: string; checked: boolean; onChange: (v: boolean) => void; detected?: boolean }) {
  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-[var(--surface-2)] transition-colors flex items-center gap-2">
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} label={label} />
      {detected && !checked && (
        <span className="text-[10px] text-[var(--brand)] font-medium bg-[var(--brand)]/10 rounded px-1.5 py-0.5">on your CV</span>
      )}
    </div>
  );
}

export function Pill({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  // Both states keep the same box model (a border is always present, no
  // checkmark is added on select) so the pill — and the wrap around it —
  // never resizes or reflows when toggled. Selection is shown by the brand
  // fill alone.
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={`inline-flex items-center gap-1 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
        selected
          ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
          : "border-[var(--border)] bg-[var(--surface)] text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)]"
      }`}>
      {label}
    </button>
  );
}
