"use client";

import { ShieldCheck } from "lucide-react";
import { useProfile } from "./context";
import { SectionCard, Field, Select, CheckBox } from "./primitives";

export function CredentialsSection() {
  const { family, creds, setCred } = useProfile();
  const showNursing = family === "nursing";
  const showManual  = family === "manual";
  if (!showNursing && !showManual) return null;

  return (
    <SectionCard icon={ShieldCheck} title="Credentials & licences" subtitle="Applies to all CVs. Surfaces as a compact 'Registration & Licences' line on care / manual CVs. Tick only what you hold.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showNursing && (
          <Field label="AHPRA Registration (RN/EN/Midwife only)" value={creds.ahpra_number ?? ""} onChange={(v) => setCred("ahpra_number", v)} placeholder="NMW0001234567" />
        )}
        <Select label="Driver Licence" value={creds.drivers_licence ?? ""} onChange={(v) => setCred("drivers_licence", v)} options={["", "Yes", "No"]} />
        <Select
          label="Australian Work Rights"
          value={creds.work_rights ?? ""}
          onChange={(v) => { setCred("work_rights", v); if (v !== "Visa with work rights") setCred("work_rights_hours", ""); }}
          options={["", "Citizen", "PR", "Visa with work rights"]}
        />
        {creds.work_rights === "Visa with work rights" && (
          <Select label="Visa Hours Type" value={creds.work_rights_hours ?? ""} onChange={(v) => setCred("work_rights_hours", v)} options={["", "Full Time", "Part Time"]} />
        )}
        {showManual && (
          <Select label="Forklift Licence" value={creds.forklift_licence ?? ""} onChange={(v) => setCred("forklift_licence", v)} options={["", "LF", "LO"]} />
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CheckBox label="Working with Children Check"      checked={!!creds.wwcc}                  onChange={(v) => setCred("wwcc", v)} />
        <CheckBox label="National Police Check (current)"  checked={!!creds.police_check}          onChange={(v) => setCred("police_check", v)} />
        <CheckBox label="Own a car"                        checked={!!creds.own_car}               onChange={(v) => setCred("own_car", v)} />
        {showManual && (
          <CheckBox label="White Card (construction)"      checked={!!creds.white_card}            onChange={(v) => setCred("white_card", v)} />
        )}
        {showNursing && (
          <>
            <CheckBox label="NDIS Worker Screening Check"       checked={!!creds.ndis_screening}        onChange={(v) => setCred("ndis_screening", v)} />
            <CheckBox label="First Aid Certificate" checked={!!creds.first_aid}             onChange={(v) => setCred("first_aid", v)} />
            <CheckBox label="CPR Certificate"       checked={!!creds.cpr}                   onChange={(v) => setCred("cpr", v)} />
            <CheckBox label="Medication Competency Certificate" checked={!!creds.medication_competency} onChange={(v) => setCred("medication_competency", v)} />
            <CheckBox label="Current Influenza Vaccination"     checked={!!creds.flu_vaccination}       onChange={(v) => setCred("flu_vaccination", v)} />
            <CheckBox label="COVID-19 Vaccination (up to date)" checked={!!creds.covid_vaccination}     onChange={(v) => setCred("covid_vaccination", v)} />
          </>
        )}
      </div>
      <p className="text-xs text-text-3">
        On care / manual CVs: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">## Registration &amp; Licences</code> — held items only.
      </p>
    </SectionCard>
  );
}
