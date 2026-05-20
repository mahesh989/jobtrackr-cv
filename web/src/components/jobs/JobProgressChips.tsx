"use client";

/**
 * Multi-select progress filter chips + two progress sort modes.
 *
 * Filter chips (AND semantics, URL-encoded as ?chips=hasCv,hasLetter,analysed):
 *   - Analysed:   has a completed analysis_runs row
 *   - Has CV:     has a tailored_pdf_storage_path (or markdown) in analysis_runs
 *   - Has Letter: has a completed cover_letters row
 *
 * Extra sorts (URL-encoded as ?sort=recently_progressed | most_progressed):
 *   - Recently progressed: by max(last_progress_at) DESC
 *   - Most progressed:     by progress_score DESC, tiebreak last_progress_at DESC
 *
 * Standard sorts (Date posted / Date added) live in the JobFilterBar.
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

const PROGRESS_SORTS = [
  { value: "recently_progressed", label: "Recently progressed" },
  { value: "most_progressed",     label: "Most progressed"     },
] as const;

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

  const selected    = parseChips(sp.get("chips"));
  const currentSort = sp.get("sort") || "posted_at";

  function toggleChip(k: ChipKey) {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k); else next.add(k);
    const params = new URLSearchParams(sp.toString());
    if (next.size > 0) params.set("chips", Array.from(next).join(","));
    else params.delete("chips");
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function setSort(value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value === currentSort) {
      params.delete("sort");
      params.delete("dir");
    } else {
      params.set("sort", value);
      params.set("dir", "desc");
    }
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

      <div className="flex-1 min-w-2" />

      <span className="text-[11px] font-medium text-text-3 mr-1">Sort</span>
      {PROGRESS_SORTS.map((opt) => {
        const active = currentSort === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => setSort(opt.value)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 h-[28px] rounded-md text-[11px] font-medium transition-all border whitespace-nowrap ${
              active
                ? "bg-text text-[var(--surface)] border-text"
                : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
