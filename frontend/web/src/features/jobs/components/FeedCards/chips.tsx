"use client";

/**
 * Small chips, pills and badges rendered on a job card.
 *
 * Split out of the former single-file FeedCards.tsx (839 lines). Pure code
 * motion — component bodies and ordering are unchanged. Every component is
 * still importable from "./FeedCards".
 *
 */
import { BarChart3, CheckCircle2, FileText, Mail } from "lucide-react";
import { BoardJob } from "../../lib/jobFilters";
// ── card sub-pieces ─────────────────────────────────────────────────────

// ── tiny presentational primitives ──────────────────────────────────────

export function ProgressDots({ progress }: { progress: BoardJob["progress"] }) {
  const items = [
    { on: progress.has_analysis,      Icon: BarChart3,    cls: "text-info",   label: "Analysed" },
    { on: progress.has_tailored_cv,   Icon: FileText,     cls: "text-accent", label: "Tailored CV" },
    { on: progress.has_cover_letter,  Icon: Mail,         cls: "text-warning",  label: "Cover letter" },
    { on: progress.is_applied,        Icon: CheckCircle2, cls: "text-success",  label: "Applied" },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map(({ on, Icon, cls, label }, i) => (
        <Icon
          key={i}
          className={`w-[15px] h-[15px] ${on ? cls : "text-text-3 opacity-30"}`}
          strokeWidth={on ? 2.5 : 1.5}
          aria-label={label}
        />
      ))}
    </div>
  );
}

const SOURCE_DOT: Record<string, string> = {
  adzuna: "var(--brand)", seek: "var(--brand)", careerjet: "var(--teal)",
  greenhouse: "var(--purple)", lever: "var(--purple)", indeed: "var(--amber)",
};

export function SourcePill({ source }: { source: string }) {
  return (
    <span
      // Demo `.source-pill`: neutral pill (surface-2 + border, 999px) with a
      // source-coloured dot — 12px/500, padding 2px 9px, gap 5px, dot 8px.
      className="inline-flex items-center gap-[5px] shrink-0 rounded-full border border-border bg-[var(--surface-2)] px-[9px] py-0.5 text-[12px] font-medium text-text-2"
      title={`Source: ${source}`}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: SOURCE_DOT[source.toLowerCase()] ?? "#94a3b8" }}
      />
      {source}
    </span>
  );
}

export function Distance({ km, method }: { km: number; method: "driving" | "haversine" | null }) {
  const approx = method === "haversine";
  const tone = km <= 10 ? "text-success" : km <= 25 ? "text-text-2" : km <= 50 ? "text-warning" : "text-danger";
  const display = km < 10 ? km.toFixed(1) : Math.round(km);
  return (
    <span
      className={`tabular-nums font-medium ${tone}`}
      title={approx ? "Straight-line estimate" : "Driving distance from your home address"}
    >
      {approx ? "~" : ""}{display} km
    </span>
  );
}
