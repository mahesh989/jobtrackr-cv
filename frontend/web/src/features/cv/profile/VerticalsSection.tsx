"use client";

import { Layers, ChevronDown } from "lucide-react";
import type { RoleFamily } from "@/lib/types";
import { useProfile } from "./context";
import { SectionCard } from "./primitives";

const FAMILY_OPTIONS: { value: RoleFamily; label: string }[] = [
  { value: "tech",    label: "Tech / Data / Engineering" },
  { value: "nursing", label: "Healthcare / Nursing / Care" },
  { value: "manual",  label: "Manual / Service / Trades" },
  { value: "general", label: "Other / General" },
];

export function VerticalsSection() {
  const { family, setFamily, showErrors } = useProfile();
  const invalid = showErrors && family === null;
  return (
    <SectionCard icon={Layers} title="What roles are you applying for?" subtitle="Applies to all CVs. Drives your skill-section labels and which credential fields show. Required for CV analysis.">
      <div className="space-y-1.5">
        <div className="select-chevron-wrap">
        <select
          value={family ?? ""}
          onChange={(e) => setFamily(e.target.value ? e.target.value as RoleFamily : null)}
          className={`field select-chevron ${invalid ? "border-[var(--red)]" : ""}`}
        >
          <option value="">— Select a role type —</option>
          {FAMILY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <ChevronDown className="h-4 w-4 text-text-2" />
        </div>
        {invalid && <p className="text-xs text-[var(--red)] font-medium">Select a role type to continue.</p>}
      </div>
    </SectionCard>
  );
}
