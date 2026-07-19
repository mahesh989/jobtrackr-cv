"use client";

import { Clock } from "lucide-react";
import { ALL_EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS } from "@/lib/constants";
import { useProfile } from "./context";
import { SectionCard, CheckBox, Pill } from "./primitives";

// Legacy Title-Case values (pre-Fix-3) → canonical snake_case tags, so values
// saved by the old checkbox UI still show as selected here.
const LEGACY_TO_CANONICAL: Record<string, string> = {
  "Full Time": "full_time",
  "Part Time": "part_time",
  "Casual":    "casual",
};

function normalizeTag(v: string): string {
  return LEGACY_TO_CANONICAL[v] ?? v;
}

export function AvailabilitySection() {
  const { creds, setCred } = useProfile();
  const selected = new Set((creds.availability ?? []).map(normalizeTag));
  return (
    <SectionCard icon={Clock} title="Work types" subtitle="Which work types you're open to. Applies to all CVs, every role type. Off by default.">
      <p className="text-xs text-text-3">
        Two effects: filters which jobs your scheduled searches keep (jobs with
        no detected type always pass), and — when &quot;Show on my CV&quot; is
        ticked — prints as an italic availability line at the end of your
        <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 mx-1">Professional Summary</code>
        (e.g. <span className="italic">Available: Casual, Part-time</span>).
      </p>
      <div className="flex flex-wrap gap-2">
        {ALL_EMPLOYMENT_TYPES.map((tag) => (
          <Pill
            key={tag}
            label={EMPLOYMENT_TYPE_LABELS[tag]}
            selected={selected.has(tag)}
            onClick={() => {
              const cur = new Set((creds.availability ?? []).map(normalizeTag));
              if (cur.has(tag)) cur.delete(tag); else cur.add(tag);
              setCred("availability", Array.from(cur));
            }}
          />
        ))}
      </div>
      <CheckBox label="Show availability on my CV" checked={!!creds.show_availability} onChange={(v) => setCred("show_availability", v)} />
      {creds.show_availability && selected.size === 0 && (
        <p className="text-xs text-amber-600">Pick at least one work type above for this to appear on your CV.</p>
      )}
    </SectionCard>
  );
}
