"use client";

import { ShieldCheck } from "lucide-react";
import { useProfile } from "./context";
import { SectionCard, Field, Select, CheckBox } from "./primitives";

export function CredentialsSection({ suggestedKeys = [] }: { suggestedKeys?: string[] }) {
  const { family, creds, setCred } = useProfile();
  const showNursing = family === "nursing";
  const showManual  = family === "manual";
  if (!showNursing && !showManual) return null;
  const isSuggested = (key: string) => suggestedKeys.includes(key);

  return (
    <SectionCard icon={ShieldCheck} title="Credentials & licences" subtitle="Applies to all CVs. Surfaces as a compact 'Registration & Licences' line on care / manual CVs. Tick only what you hold.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showNursing && (
          <Field label="AHPRA Registration (RN/EN/Midwife only)" value={creds.ahpra_number ?? ""} onChange={(v) => setCred("ahpra_number", v)} placeholder="NMW0001234567" />
        )}
        <Select label="Driver Licence" value={creds.drivers_licence ?? ""} onChange={(v) => setCred("drivers_licence", v)} options={["", "Yes", "No"]} />
        {showManual && (
          <Select label="Forklift Licence" value={creds.forklift_licence ?? ""} onChange={(v) => setCred("forklift_licence", v)} options={["", "LF", "LO"]} />
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CheckBox label="Working with Children Check"      checked={!!creds.wwcc}                  onChange={(v) => setCred("wwcc", v)} detected={isSuggested("wwcc")} />
        <CheckBox label="National Police Check (current)"  checked={!!creds.police_check}          onChange={(v) => setCred("police_check", v)} detected={isSuggested("police_check")} />
        <CheckBox label="Own a car"                        checked={!!creds.own_car}               onChange={(v) => setCred("own_car", v)} />
        {showManual && (
          <CheckBox label="White Card (construction)"      checked={!!creds.white_card}            onChange={(v) => setCred("white_card", v)} detected={isSuggested("white_card")} />
        )}
        {showNursing && (
          <>
            <CheckBox label="NDIS Worker Screening Check"       checked={!!creds.ndis_screening}        onChange={(v) => setCred("ndis_screening", v)} detected={isSuggested("ndis_screening")} />
            <CheckBox label="First Aid Certificate" checked={!!creds.first_aid}             onChange={(v) => setCred("first_aid", v)} detected={isSuggested("first_aid")} />
            <CheckBox label="CPR Certificate"       checked={!!creds.cpr}                   onChange={(v) => setCred("cpr", v)} detected={isSuggested("cpr")} />
            <CheckBox label="Medication Competency Certificate" checked={!!creds.medication_competency} onChange={(v) => setCred("medication_competency", v)} detected={isSuggested("medication_competency")} />
            <CheckBox label="Current Influenza Vaccination"     checked={!!creds.flu_vaccination}       onChange={(v) => setCred("flu_vaccination", v)} detected={isSuggested("flu_vaccination")} />
            <CheckBox label="COVID-19 Vaccination (up to date)" checked={!!creds.covid_vaccination}     onChange={(v) => setCred("covid_vaccination", v)} detected={isSuggested("covid_vaccination")} />
          </>
        )}
      </div>
      <p className="text-xs text-text-3">
        On care / manual CVs: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">## Registration &amp; Licences</code> — held items only. Work rights now live in the Details tab&apos;s Working rights field.
      </p>
    </SectionCard>
  );
}
