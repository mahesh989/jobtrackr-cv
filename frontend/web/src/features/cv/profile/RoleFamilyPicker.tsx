"use client";

import { ChevronDown } from "lucide-react";
import type { RoleFamily } from "./types";
import { formatFamilyLabel } from "./types";

export function RoleFamilyPicker({
  family, setFamily,
}: {
  family:    RoleFamily | null;
  setFamily: (v: RoleFamily | null) => void;
}) {
  const anySelected = family !== null;

  return (
    <>
      <div className="glass rounded-lg shadow-gold p-6 space-y-4">
        <div>
          <h2 className="label-luxury text-text-2">What roles are you applying for?</h2>
          <p className="mt-1 text-xs text-text-3">
            Choose the role type for your CV tailoring pipeline. Extra fields appear below for each type.
          </p>
        </div>
        <div className="select-chevron-wrap">
          <select
            value={family ?? ""}
            onChange={(e) => setFamily(e.target.value ? e.target.value as RoleFamily : null)}
            className="select-chevron w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
          >
            <option value="">— Select a role type —</option>
            <option value="tech">Tech / Data / Engineering</option>
            <option value="nursing">Healthcare / Nursing / Care</option>
            <option value="manual">Manual / Service / Trades</option>
            <option value="general">Other / General</option>
          </select>
          <ChevronDown className="h-4 w-4 text-text-2" />
        </div>
        {anySelected && (
          <p className="text-xs text-text-3">
            Showing add-on fields for: <span className="font-medium text-text-2">{formatFamilyLabel(family!)}</span>
          </p>
        )}
      </div>

      {!anySelected && (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-6 py-10 text-center">
          <p className="text-sm text-text-2">
            Pick at least one role family above to customize your profile.
          </p>
          <p className="mt-1 text-xs text-text-3">
            Tech links, healthcare credentials, and manual/trade credentials
            appear only when you&apos;ve selected the matching family.
          </p>
        </div>
      )}
    </>
  );
}
