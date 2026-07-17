"use client";

import { Clock } from "lucide-react";
import { useProfile } from "./context";
import { SectionCard, CheckBox, Pill } from "./primitives";

const AVAILABILITY_OPTIONS = ["Full Time", "Part Time", "Casual"] as const;

export function AvailabilitySection() {
  const { creds, setCred } = useProfile();
  return (
    <SectionCard icon={Clock} title="Availability" subtitle="Which shifts you want. Applies to all CVs, every role type. Off by default.">
      <p className="text-xs text-text-3">
        When shown, appears as an italic line at the end of your
        <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 mx-1">Professional Summary</code>
        (e.g. <span className="italic">Available: Casual, Part Time</span>).
      </p>
      <div className="flex flex-wrap gap-2">
        {AVAILABILITY_OPTIONS.map((opt) => (
          <Pill
            key={opt}
            label={opt}
            selected={(creds.availability ?? []).includes(opt)}
            onClick={() => {
              const cur = creds.availability ?? [];
              setCred("availability", cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]);
            }}
          />
        ))}
      </div>
      <CheckBox label="Show availability on my CV" checked={!!creds.show_availability} onChange={(v) => setCred("show_availability", v)} />
      {creds.show_availability && (creds.availability ?? []).length === 0 && (
        <p className="text-xs text-amber-600">Pick at least one shift type above for this to appear on your CV.</p>
      )}
    </SectionCard>
  );
}
