"use client";

/**
 * Multi-select progress filter chips.
 *
 * URL-encoded as ?chips=hasCv,hasLetter,analysed — AND semantics.
 *   - Analysed:   has a completed analysis_runs row
 *   - Has CV:     has a tailored_pdf_storage_path (or markdown) in analysis_runs
 *   - Has Letter: has a completed cover_letters row
 *
 * All sort modes (date + progress) live in the JobFilterBar — single
 * row, single label, no duplication.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { Check, FileText, Mail, BarChart3, Sparkles, FileWarning, AlertTriangle, AtSign, MinusCircle } from "lucide-react";

export type ChipKey =
  // progress chips (existing)
  | "analysed" | "hasCv" | "hasLetter"
  // triage / outbox chips (Phase B — new)
  | "needsJd" | "roleMismatch" | "hasEmail" | "autoSkipped";

export interface JobProgressChipCounts {
  analysed:     number;
  hasCv:        number;
  hasLetter:    number;
  needsJd:      number;
  roleMismatch: number;
  hasEmail:     number;
  autoSkipped:  number;
}

// Two visual groups separated by a centered dot.
const PROGRESS_CHIPS: Array<{ key: ChipKey; label: string; Icon: typeof Check }> = [
  { key: "analysed",  label: "Analysed",   Icon: BarChart3 },
  { key: "hasCv",     label: "Has CV",     Icon: FileText },
  { key: "hasLetter", label: "Has Letter", Icon: Mail },
];

const TRIAGE_CHIPS: Array<{ key: ChipKey; label: string; Icon: typeof Check }> = [
  { key: "needsJd",      label: "Needs JD",         Icon: FileWarning   },
  { key: "roleMismatch", label: "Role mismatch",    Icon: AlertTriangle },
  { key: "hasEmail",     label: "Has email",        Icon: AtSign        },
  { key: "autoSkipped",  label: "Below threshold",  Icon: MinusCircle   },
];

function parseChips(raw: string | null): Set<ChipKey> {
  if (!raw) return new Set();
  const valid = new Set<ChipKey>([
    "analysed", "hasCv", "hasLetter",
    "needsJd", "roleMismatch", "hasEmail", "autoSkipped",
  ]);
  return new Set(raw.split(",").map((s) => s.trim()).filter((s): s is ChipKey => valid.has(s as ChipKey)));
}

export function JobProgressChips({ counts }: { counts: JobProgressChipCounts }) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [, startTransition] = useTransition();

  const selected = parseChips(sp.get("chips"));

  function toggleChip(k: ChipKey) {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k); else next.add(k);
    const params = new URLSearchParams(sp.toString());
    if (next.size > 0) params.set("chips", Array.from(next).join(","));
    else params.delete("chips");
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function renderChip(c: { key: ChipKey; label: string; Icon: typeof Check }) {
    const active = selected.has(c.key);
    const count  = counts[c.key];
    return (
      <button
        key={c.key}
        onClick={() => toggleChip(c.key)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 h-[28px] rounded-full text-[11px] font-medium border transition-all whitespace-nowrap ${
          active
            ? "bg-[var(--brand)] text-[var(--brand-fg)] border-[var(--brand)]"
            : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text hover:border-[var(--text-3)]"
        }`}
        title={active ? `Hide "${c.label}" filter` : `Show only jobs with "${c.label}"`}
      >
        <c.Icon className="w-3 h-3 shrink-0" />
        {c.label}
        <span className={`text-[10px] font-bold ${active ? "opacity-90" : "opacity-60"}`}>
          {count}
        </span>
        {active && <Check className="w-3 h-3 shrink-0 opacity-90" />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Sparkles className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />
      <span className="text-[11px] font-semibold text-text-2 uppercase tracking-wider mr-1">Progress</span>
      {PROGRESS_CHIPS.map(renderChip)}

      {/* Visual separator between the two groups */}
      <span className="text-text-3 mx-1 select-none" aria-hidden>·</span>

      <span className="text-[11px] font-semibold text-text-2 uppercase tracking-wider mr-1">Triage</span>
      {TRIAGE_CHIPS.map(renderChip)}
    </div>
  );
}
