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
import { Check, FileText, Mail, BarChart3, Sparkles } from "lucide-react";

export type ChipKey = "analysed" | "hasCv" | "hasLetter";

export interface JobProgressChipCounts {
  analysed:  number;
  hasCv:     number;
  hasLetter: number;
}

const CHIPS: Array<{ key: ChipKey; label: string; Icon: typeof Check }> = [
  { key: "analysed",  label: "Analysed",   Icon: BarChart3 },
  { key: "hasCv",     label: "Has CV",     Icon: FileText },
  { key: "hasLetter", label: "Has Letter", Icon: Mail },
];

function parseChips(raw: string | null): Set<ChipKey> {
  if (!raw) return new Set();
  const valid = new Set<ChipKey>(["analysed", "hasCv", "hasLetter"]);
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

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Sparkles className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />
      <span className="text-[11px] font-semibold text-text-2 uppercase tracking-wider mr-1">Progress</span>

      {CHIPS.map(({ key, label, Icon }) => {
        const active = selected.has(key);
        const count  = counts[key];
        return (
          <button
            key={key}
            onClick={() => toggleChip(key)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 h-[28px] rounded-full text-[11px] font-medium border transition-all whitespace-nowrap ${
              active
                ? "bg-[var(--brand)] text-[var(--brand-fg)] border-[var(--brand)]"
                : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text hover:border-[var(--text-3)]"
            }`}
            title={active ? `Hide "${label}" filter` : `Show only jobs with "${label}"`}
          >
            <Icon className="w-3 h-3 shrink-0" />
            {label}
            <span className={`text-[10px] font-bold ${active ? "opacity-90" : "opacity-60"}`}>
              {count}
            </span>
            {active && <Check className="w-3 h-3 shrink-0 opacity-90" />}
          </button>
        );
      })}
    </div>
  );
}
