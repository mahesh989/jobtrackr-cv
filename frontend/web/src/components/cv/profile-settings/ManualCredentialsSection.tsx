"use client";

import { Select, CheckBox } from "./Field";
import type { ProfileCredentials } from "./types";

export function ManualCredentialsSection({
  creds, setCred, showNursing,
}: {
  creds:       ProfileCredentials;
  setCred:     <K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) => void;
  showNursing: boolean;
}) {
  return (
    <div className="glass rounded-lg shadow-gold p-6 space-y-4">
      <div>
        <h2 className="label-luxury text-text-2">Manual / Service Credentials</h2>
        <p className="mt-1 text-xs text-text-3">
          Surfaces on cleaning, kitchen, warehouse, driver, and trades
          CVs. Shares Driver Licence / Work Rights / Police Check / WWCC
          with the Healthcare block above — fill them once, they appear
          wherever relevant.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          label="Forklift Licence"
          value={creds.forklift_licence ?? ""}
          onChange={(v) => setCred("forklift_licence", v)}
          options={["", "LF", "LO"]}
        />
        {!showNursing && (
          <>
            <Select
              label="Driver Licence"
              value={creds.drivers_licence ?? ""}
              onChange={(v) => setCred("drivers_licence", v)}
              options={["", "Yes", "No"]}
            />
            <Select
              label="Australian Work Rights"
              value={creds.work_rights ?? ""}
              onChange={(v) => {
                setCred("work_rights", v);
                if (v !== "Visa with work rights") {
                  setCred("work_rights_hours", "");
                }
              }}
              options={["", "Citizen", "PR", "Visa with work rights"]}
            />
            {creds.work_rights === "Visa with work rights" && (
              <Select
                label="Visa Hours Type"
                value={creds.work_rights_hours ?? ""}
                onChange={(v) => setCred("work_rights_hours", v)}
                options={["", "Full Time", "Part Time"]}
              />
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CheckBox label="White Card (construction)"  checked={!!creds.white_card}    onChange={(v) => setCred("white_card", v)} />
        {!showNursing && (
          <>
            <CheckBox label="National Police Check (current)" checked={!!creds.police_check} onChange={(v) => setCred("police_check", v)} />
            <CheckBox label="Working with Children Check"     checked={!!creds.wwcc}         onChange={(v) => setCred("wwcc", v)} />
            <CheckBox label="Own a car"                       checked={!!creds.own_car}      onChange={(v) => setCred("own_car", v)} />
          </>
        )}
      </div>

      <p className="text-xs text-text-3">
        On manual / service CVs: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">## Registration &amp; Licences</code> — held items only.
      </p>
    </div>
  );
}
