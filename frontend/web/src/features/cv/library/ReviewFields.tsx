"use client";

/**
 * Presentational building blocks for the CV review form (split out of
 * ReviewClient.tsx — audit batch 5.2): Section shells, ghost inputs,
 * date fields, bullet rows, skills buckets, timeline chrome.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus, X, type LucideIcon } from "lucide-react";
import { Input, Textarea, IconButton } from "@/components/ui";

export function Section({
  id, icon: Icon, title, subtitle, meta, open, onToggle, onClose, children }: {
  id?:       string;
  icon:      LucideIcon;
  title:     string;
  subtitle?: string;
  meta?:     string;
  open:      boolean;
  onToggle:  () => void;
  onClose?:  () => void;
  children:  React.ReactNode;
}) {
  return (
    <section id={id} className={`group relative rounded-xl border bg-[var(--surface)] transition-all ${open ? "border-[var(--border)] shadow-sm" : "border-[var(--border)]/70 hover:border-[var(--border)] hover:shadow-sm"}`}>
      {open && <span aria-hidden="true" className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-[var(--brand)]/70" />}
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button type="button" onClick={onToggle} className="flex flex-1 items-center gap-3 text-left min-w-0" aria-expanded={open}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${open ? "bg-[var(--brand)]/10 text-[var(--brand)]" : "bg-[var(--surface-2)]/60 text-text-3 group-hover:bg-[var(--brand)]/10 group-hover:text-[var(--brand)]"}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-title font-semibold text-text">{title}</span>
              {meta && (
                <span className="text-caption text-text-3 px-1.5 py-0.5 rounded-full bg-[var(--surface-2)]/60">
                  {meta}
                </span>
              )}
            </div>
            {subtitle && <p className="text-label text-text-3 mt-0.5 truncate">{subtitle}</p>}
          </div>
          {open
            ? <ChevronDown  className="h-4 w-4 text-text-3 shrink-0" aria-hidden="true" />
            : <ChevronRight className="h-4 w-4 text-text-3 shrink-0" aria-hidden="true" />}
        </button>
        {onClose && (
          <IconButton
            onClick={onClose}
            aria-label={`Remove ${title} section`}
            icon={<X className="h-3.5 w-3.5" />}
          />
        )}
      </div>
      {open && <div className="px-4 pb-4 pt-1 space-y-3">{children}</div>}
    </section>
  );
}

export function Grid({ cols = 2, mt, children }: { cols?: number; mt?: boolean; children: React.ReactNode }) {
  const colClass = cols === 3 ? "sm:grid-cols-3" : cols === 2 ? "sm:grid-cols-2" : "";
  return <div className={`grid gap-3 ${mt ? "mt-3" : ""} grid-cols-1 ${colClass}`}>{children}</div>;
}

export function GhostField({
  label, value, onChange, size = "md", invalid = false, required = false }: { label: string; value: string; onChange: (v: string) => void; size?: "md" | "lg"; invalid?: boolean; required?: boolean }) {
  // Leans on the shared Input's field SSOT: `required` renders the red
  // asterisk, `error` renders the red invalid border — no bespoke border /
  // focus-ring override (that stacked a second ring on top of .field's).
  const sized = size === "lg" ? "text-title font-semibold" : "";
  return (
    <Input
      label={label}
      required={required}
      error={invalid ? "required" : undefined}
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      className={sized}
    />
  );
}

export function GhostTextarea({
  rows, value, onChange, placeholder }: { rows: number; value: string; onChange: (v: string) => void; placeholder?: string }) {
  // Shared Textarea (field SSOT) + autoGrow so it matches every other field
  // and expands to fit content instead of scrolling / needing a drag handle.
  return (
    <Textarea
      autoGrow
      rows={rows}
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="leading-relaxed"
    />
  );
}

export function DatesField({ start, end, onStart, onEnd, invalid = false }: {
  start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void; invalid?: boolean;
}) {
  const blank = !start && !end;
  const border = invalid
    ? "border-red-500 focus:border-red-500 focus:ring-red-500/20"
    : "border-[var(--border)] focus:border-[var(--brand)]/70 focus:ring-[var(--brand)]/15";
  return (
    <div>
      <span className="text-caption uppercase tracking-wider text-text-3 font-medium block mb-1">
        Dates {(blank || invalid) && <span className="normal-case tracking-normal text-red-600 font-semibold">· {invalid ? "required" : "missing"}</span>}
      </span>
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          type="text"
          value={start}
          onChange={e => onStart(e.target.value)}
          placeholder="Start"
          aria-label="Start date"
          className={`text-body py-1.5 ${border}`}
        />
        <Input
          type="text"
          value={end}
          onChange={e => onEnd(e.target.value)}
          placeholder="End or Present"
          aria-label="End date"
          className={`text-body py-1.5 ${border}`}
        />
      </div>
    </div>
  );
}

export function BulletRow({ value, onChange, onRemove }: {
  value: string; onChange: (v: string) => void; onRemove: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow: the box height tracks the content (no scrollbar, no manual
  // drag handle) — resets to auto so it can shrink as well as grow.
  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(autoGrow, [value, autoGrow]);
  return (
    <div className="group/bullet flex items-start gap-2 py-1 rounded-md hover:bg-[var(--surface-2)]/30 transition-colors">
      <span className="mt-[13px] select-none text-[var(--brand)]/60 leading-none text-micro shrink-0" aria-hidden="true">●</span>
      <textarea
        ref={ref}
        rows={1}
        className="field min-w-0 resize-none overflow-hidden leading-relaxed"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <button type="button" onClick={onRemove} aria-label="Remove bullet" className="mt-2 p-1 opacity-0 group-hover/bullet:opacity-100 focus:opacity-100 transition-opacity">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type SkillTone = "care" | "soft" | "neutral";

export function SkillsBucket({
  label, tone, bucket, items, onAdd, onRemove }: {
  label:    string;
  tone:     SkillTone;
  bucket:   "domain_knowledge" | "soft_skills" | "technical";
  items:    string[];
  onAdd:    (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
  onRemove: (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
}) {
  const [input, setInput] = useState("");
  const dotClass =
    tone === "care"  ? "bg-emerald-500" :
    tone === "soft"  ? "bg-amber-500"   :
                       "bg-text-3/60";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <div className="text-caption uppercase tracking-wider text-text-3 font-medium">{label}</div>
        <span className="text-caption text-text-3">{items.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {items.map(s => (
          <span key={s} className="group/chip inline-flex items-center gap-1 text-label pl-2 pr-1 py-0.5 rounded-full bg-[var(--surface-2)]/80 border border-[var(--border)]/60 hover:border-[var(--border)] transition-colors">
            <span className="text-text">{s}</span>
            <button
              type="button"
              onClick={() => onRemove(bucket, s)}
              aria-label={`Remove ${s}`}
              className="text-text-3 hover:text-text rounded-full p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <Input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); onAdd(bucket, input); setInput(""); }
          }}
          placeholder="add…"
          className="text-label h-6 w-24 rounded-full border border-dashed border-[var(--border)] bg-transparent px-2.5 placeholder:text-text-3 focus:outline-none focus:border-[var(--brand)]/70 focus:bg-[var(--surface-2)]/40 transition-colors"
          aria-label={`Add ${label}`}
        />
      </div>
    </div>
  );
}

export function TimelineEntry({
  dateLabel, isFirst, isLast, children }: {
  dateLabel: string;
  isFirst:   boolean;
  isLast:    boolean;
  children:  React.ReactNode;
}) {
  return (
    <li className={`relative pl-7 sm:pl-9 ${isLast ? "" : "pb-6"}`}>
      {!isLast && (
        <span aria-hidden="true" className="absolute left-[9px] sm:left-[11px] top-3 bottom-0 w-px bg-[var(--border)]" />
      )}
      <span aria-hidden="true" className={`absolute left-[5px] sm:left-[7px] top-2.5 h-2 w-2 rounded-full ring-2 ring-[var(--surface)] ${isFirst ? "bg-[var(--brand)]" : "bg-[var(--border)]"}`} />
      <div className="text-caption text-text-2 font-medium mb-2 -mt-0.5">{dateLabel || <span className="text-text-3 italic">no dates</span>}</div>
      <div>{children}</div>
    </li>
  );
}

export function EmptyState({ icon: Icon, text, actionLabel, onAction }: {
  icon: LucideIcon; text: string; actionLabel?: string; onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6 px-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-2)]/60 text-text-3 mb-2">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="text-body text-text-3 max-w-xs">{text}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--brand)] hover:underline">
          <Plus className="h-3.5 w-3.5" /> {actionLabel}
        </button>
      )}
    </div>
  );
}

export function AddBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs text-text-2 hover:text-text mt-3 rounded-md px-2 py-1 -ml-2 hover:bg-[var(--surface-2)]/60 transition-colors"
    >
      <Plus className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

export function RemoveBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <IconButton
      onClick={onClick}
      aria-label={label}
      variant="danger"
      size="sm"
      icon={<X className="h-3.5 w-3.5" />}
      className="mt-5"
    />
  );
}


