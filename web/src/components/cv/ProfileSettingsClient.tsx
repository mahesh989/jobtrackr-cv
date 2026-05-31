"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ExternalLink } from "lucide-react";

interface Project {
  name?:        string;
  url?:         string;
  description?: string;
}

/**
 * Healthcare / care credentials captured in the profile and surfaced
 * compactly on tailored CVs for nursing/healthcare/care role families.
 * All optional. Only positive ("held") items are shown on the CV —
 * a profile with no flags set produces no Registration & Licences section.
 */
export interface HealthcareCredentials {
  ahpra_number?:         string;      // RN/EN/Midwife only — "NMW0001234567"
  drivers_licence?:      string;      // "" | "Open" | "Provisional" | "Learner"
  own_car?:              boolean;
  car_insurance?:        boolean;     // comprehensive
  work_rights?:          string;      // "" | "Citizen" | "PR" | "Visa with work rights"
  police_check?:         boolean;     // current national police check
  ndis_screening?:       boolean;     // NDIS Worker Screening Check
  wwcc?:                 boolean;     // Working with Children Check
  wwcc_state?:           string;      // "" | "NSW" | "VIC" | "QLD" | "WA" | "SA" | "TAS" | "ACT" | "NT"
  first_aid?:            boolean;     // HLTAID011
  cpr?:                  boolean;     // HLTAID009
  flu_vaccination?:      boolean;     // current
  medication_competency?: boolean;
}

export interface ContactDetails {
  name?:         string;
  phone?:        string;
  email?:        string;
  address?:      string;
  suburb?:       string;
  postcode?:     string;
  linkedin?:     string;
  github?:       string;
  website?:      string;
  portfolio?:    string;
  other_label?:  string;
  other_url?:    string;
  projects?:     Project[];
  /** Surfaces on tailored CVs only when the JD's role family is nursing/
   *  healthcare/care. Stays hidden on tech/general/manual CVs. */
  credentials?:  HealthcareCredentials;
}

interface Props {
  initial: ContactDetails | null;
}

const EMPTY: ContactDetails = {};

/**
 * Profile settings — ported to cv-magic's design language.
 *
 * Uses `.glass`, `.label-luxury`, and `.glow-gold` utility classes
 * defined in globals.css so every theme renders consistently with
 * cv-magic for the four cv-magic themes and inherits a tasteful card
 * style on Default.
 */
export function ProfileSettingsClient({ initial }: Props) {
  const router = useRouter();
  const [cd, setCd]             = useState<ContactDetails>(initial ?? EMPTY);
  const [projects, setProjects] = useState<Project[]>(initial?.projects ?? []);
  const [creds, setCreds]       = useState<HealthcareCredentials>(initial?.credentials ?? {});
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  function setField<K extends keyof ContactDetails>(k: K, v: string) {
    setCd((prev) => ({ ...prev, [k]: v }));
  }
  function setCred<K extends keyof HealthcareCredentials>(k: K, v: HealthcareCredentials[K]) {
    setCreds((prev) => ({ ...prev, [k]: v }));
  }
  function addProject() {
    setProjects((p) => [...p, { name: "", url: "", description: "" }]);
  }
  function removeProject(i: number) {
    setProjects((p) => p.filter((_, idx) => idx !== i));
  }
  function patchProject(i: number, field: keyof Project, value: string) {
    setProjects((p) => p.map((proj, idx) => idx === i ? { ...proj, [field]: value } : proj));
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/user/preferences", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contact_details: { ...cd, projects, credentials: creds } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? `Failed (${res.status})`); return; }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Contact Details card ── */}
      <div className="glass rounded-lg shadow-gold p-6 space-y-4">
        <div>
          <h2 className="label-luxury text-text-2">Contact Details</h2>
          <p className="mt-1 text-xs text-text-3">
            Used to stamp a clean contact line on every tailored CV. LinkedIn,
            GitHub, and Portfolio appear as clickable links. Leave fields blank
            to omit them.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full Name"          value={cd.name        ?? ""} onChange={(v) => setField("name",        v)} placeholder="Jane Doe" />
          <Field label="Phone"              value={cd.phone       ?? ""} onChange={(v) => setField("phone",       v)} placeholder="+61 414 032 507" type="tel" />
          <Field label="Email"              value={cd.email       ?? ""} onChange={(v) => setField("email",       v)} placeholder="you@example.com" type="email" />
          <Field label="Address / Location" value={cd.address     ?? ""} onChange={(v) => setField("address",     v)} placeholder="Street address" />
          <Field label="Suburb"             value={cd.suburb      ?? ""} onChange={(v) => setField("suburb",      v)} placeholder="Hurstville" />
          <Field label="Postcode"           value={cd.postcode    ?? ""} onChange={(v) => setField("postcode",    v)} placeholder="2220" />
          <Field label="LinkedIn URL"       value={cd.linkedin    ?? ""} onChange={(v) => setField("linkedin",    v)} placeholder="linkedin.com/in/yourname" />
          <Field label="GitHub URL"         value={cd.github      ?? ""} onChange={(v) => setField("github",      v)} placeholder="github.com/yourname" />
          <Field label="Portfolio URL"      value={cd.portfolio   ?? ""} onChange={(v) => setField("portfolio",   v)} placeholder="yourname.dev" />
          <Field label="Website URL"        value={cd.website     ?? ""} onChange={(v) => setField("website",     v)} placeholder="(used only if no Portfolio)" />
          <Field label="Other (label)"      value={cd.other_label ?? ""} onChange={(v) => setField("other_label", v)} placeholder="e.g. Medium, Substack" />
          <Field label="Other (URL)"        value={cd.other_url   ?? ""} onChange={(v) => setField("other_url",   v)} placeholder="https://..." />
        </div>

        <p className="text-xs text-text-3">
          On your CV: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">Address | Phone | Email | LinkedIn | GitHub | Portfolio</code>
        </p>
      </div>

      {/* ── Portfolio Projects card ── */}
      <div className="glass rounded-lg shadow-gold p-6 space-y-4">
        <div>
          <h2 className="label-luxury text-text-2">Portfolio Projects</h2>
          <p className="mt-1 text-xs text-text-3">
            These are passed to the AI when tailoring your CV — it will reference
            relevant projects for each role. Add name, live URL, and a one-line
            description.
          </p>
        </div>

        <div className="space-y-3">
          {projects.map((proj, i) => (
            <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-text-2">Project {i + 1}</span>
                <button
                  onClick={() => removeProject(i)}
                  className="rounded p-1 hover:bg-red-light hover:text-red transition-colors"
                  aria-label="Remove project"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-2">Name</label>
                  <input
                    type="text"
                    value={proj.name ?? ""}
                    onChange={(e) => patchProject(i, "name", e.target.value)}
                    placeholder="e.g. CV Magic"
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-2">URL</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="url"
                      value={proj.url ?? ""}
                      onChange={(e) => patchProject(i, "url", e.target.value)}
                      placeholder="https://github.com/you/project"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
                    />
                    {proj.url && (
                      <a
                        href={proj.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-text-3 hover:text-[var(--brand)]"
                        aria-label="Open project URL"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-text-2">
                  One-line description <span className="font-normal text-text-3">(optional)</span>
                </label>
                <input
                  type="text"
                  value={proj.description ?? ""}
                  onChange={(e) => patchProject(i, "description", e.target.value)}
                  placeholder="e.g. AI-powered CV tailoring tool built with Next.js and FastAPI"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
                />
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={addProject}
          className="flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm font-medium text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors w-full justify-center"
        >
          <Plus className="h-4 w-4" />
          Add project
        </button>
      </div>

      {/* ── Healthcare / Care Credentials card ── */}
      <div className="glass rounded-lg shadow-gold p-6 space-y-4">
        <div>
          <h2 className="label-luxury text-text-2">Healthcare / Care Credentials</h2>
          <p className="mt-1 text-xs text-text-3">
            Used only when tailoring for nursing, aged-care, disability, or
            community-care roles. Surfaces as a compact <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">Registration &amp; Licences</code> line
            on the CV. Tick only what you hold — nothing negative is ever
            shown. Leave the whole block empty for non-care roles.
          </p>
        </div>

        {/* Registration */}
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
            options={["", "Open", "Provisional", "Learner"]}
          />
          <Select
            label="Australian Work Rights"
            value={creds.work_rights ?? ""}
            onChange={(v) => setCred("work_rights", v)}
            options={["", "Citizen", "PR", "Visa with work rights"]}
          />
          <Select
            label="WWCC State (if you hold a Working with Children Check)"
            value={creds.wwcc_state ?? ""}
            onChange={(v) => setCred("wwcc_state", v)}
            options={["", "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]}
          />
        </div>

        {/* Held — checkboxes */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CheckBox label="Working with Children Check"           checked={!!creds.wwcc}                  onChange={(v) => setCred("wwcc", v)} />
          <CheckBox label="National Police Check (current)"        checked={!!creds.police_check}          onChange={(v) => setCred("police_check", v)} />
          <CheckBox label="NDIS Worker Screening Check"            checked={!!creds.ndis_screening}        onChange={(v) => setCred("ndis_screening", v)} />
          <CheckBox label="First Aid Certificate (HLTAID011)"      checked={!!creds.first_aid}             onChange={(v) => setCred("first_aid", v)} />
          <CheckBox label="CPR Certificate (HLTAID009)"            checked={!!creds.cpr}                   onChange={(v) => setCred("cpr", v)} />
          <CheckBox label="Medication Competency Certificate"      checked={!!creds.medication_competency} onChange={(v) => setCred("medication_competency", v)} />
          <CheckBox label="Own a Reliable Car"                     checked={!!creds.own_car}               onChange={(v) => setCred("own_car", v)} />
          <CheckBox label="Comprehensive Car Insurance"            checked={!!creds.car_insurance}         onChange={(v) => setCred("car_insurance", v)} />
          <CheckBox label="Current Influenza Vaccination"          checked={!!creds.flu_vaccination}       onChange={(v) => setCred("flu_vaccination", v)} />
        </div>

        <p className="text-xs text-text-3">
          On nursing/care CVs: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">## Registration &amp; Licences</code> — held items only, in a single compact line.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-light border border-red/20 px-3 py-2 text-[12px] text-red">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-shadow hover:opacity-90 hover:glow-gold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save preferences"}
        </button>
        {savedFlash && <span className="text-sm text-green">✓ Saved</span>}
      </div>
    </div>
  );
}

/* ─── Form field — cv-magic style ─────────────────────────────── */

function Field({
  label, value, onChange, type = "text", placeholder,
}: {
  label:        string;
  value:        string;
  onChange:     (v: string) => void;
  type?:        string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
      />
    </div>
  );
}

function Select({
  label, value, onChange, options,
}: {
  label:    string;
  value:    string;
  onChange: (v: string) => void;
  options:  string[];
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt || "—"}</option>
        ))}
      </select>
    </div>
  );
}

function CheckBox({
  label, checked, onChange,
}: {
  label:    string;
  checked:  boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 hover:bg-[var(--surface-2)] transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30"
      />
      <span className="text-sm text-text">{label}</span>
    </label>
  );
}
