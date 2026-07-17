"use client";

import { Field, Select, CheckBox } from "./Field";
import type { ProfileCredentials } from "./types";

export function HealthcareCredentialsSection({
  creds, setCred,
}: {
  creds:   ProfileCredentials;
  setCred: <K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) => void;
}) {
  return (
    <div className="glass rounded-lg shadow-gold p-6 space-y-4">
      <div>
        <h2 className="label-luxury text-text-2">Healthcare / Care Credentials</h2>
        <p className="mt-1 text-xs text-text-3">
          Surfaces as a compact <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">Registration &amp; Licences</code> line
          on nursing / aged-care / disability / community-care CVs.
          Tick only what you hold — nothing negative is ever shown.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="AHPRA Registration (RN/EN/Midwife only)"
          value={creds.ahpra_number ?? ""}
          onChange={(v) => setCred("ahpra_number", v)}
          placeholder="NMW0001234567"
        />
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
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CheckBox label="Working with Children Check"        checked={!!creds.wwcc}                  onChange={(v) => setCred("wwcc", v)} />
        <CheckBox label="National Police Check (current)"     checked={!!creds.police_check}          onChange={(v) => setCred("police_check", v)} />
        <CheckBox label="NDIS Worker Screening Check"         checked={!!creds.ndis_screening}        onChange={(v) => setCred("ndis_screening", v)} />
        <CheckBox label="First Aid Certificate"   checked={!!creds.first_aid}             onChange={(v) => setCred("first_aid", v)} />
        <CheckBox label="CPR Certificate"         checked={!!creds.cpr}                   onChange={(v) => setCred("cpr", v)} />
        <CheckBox label="Medication Competency Certificate"   checked={!!creds.medication_competency} onChange={(v) => setCred("medication_competency", v)} />
        <CheckBox label="Own a car"                           checked={!!creds.own_car}               onChange={(v) => setCred("own_car", v)} />
        <CheckBox label="Current Influenza Vaccination"       checked={!!creds.flu_vaccination}       onChange={(v) => setCred("flu_vaccination", v)} />
        <CheckBox label="COVID-19 Vaccination (up to date)"   checked={!!creds.covid_vaccination}     onChange={(v) => setCred("covid_vaccination", v)} />
      </div>

      <p className="text-xs text-text-3">
        On nursing/care CVs: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">## Registration &amp; Licences</code> — held items only, in a single compact line.
      </p>
    </div>
  );
}
