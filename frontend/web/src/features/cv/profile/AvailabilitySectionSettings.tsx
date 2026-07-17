"use client";

import { CheckBox, Pill } from "./Field";
import type { ProfileCredentials } from "./types";
import { AVAILABILITY_OPTIONS } from "./types";

export function AvailabilitySection({
  creds, setCred, toggleAvailability,
}: {
  creds:              ProfileCredentials;
  setCred:            <K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) => void;
  toggleAvailability: (v: string) => void;
}) {
  return (
    <div className="glass rounded-lg shadow-gold p-6 space-y-4">
      <div>
        <h2 className="label-luxury text-text-2">Availability</h2>
        <p className="mt-1 text-xs text-text-3">
          Which shifts you want to work. When shown, this appears on its own
          italic line under
          <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 mx-1">Registration &amp; Licences</code>
          (e.g. <span className="italic text-text-2">Available: Casual, Part Time</span>) —
          no separate CV section. Off by default; flip the toggle below to include it.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {AVAILABILITY_OPTIONS.map((opt) => (
          <Pill
            key={opt}
            label={opt}
            selected={(creds.availability ?? []).includes(opt)}
            onClick={() => toggleAvailability(opt)}
          />
        ))}
      </div>

      <CheckBox
        label="Show availability on my CV"
        checked={!!creds.show_availability}
        onChange={(v) => setCred("show_availability", v)}
      />
      {creds.show_availability && (creds.availability ?? []).length === 0 && (
        <p className="text-xs text-amber-600">
          Pick at least one shift type above for this to appear on your CV.
        </p>
      )}
    </div>
  );
}
