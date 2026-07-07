"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ExternalLink, ChevronDown } from "lucide-react";

interface Project {
  name?:        string;
  url?:         string;
  description?: string;
}

/**
 * Unified credentials block captured in the profile. The CV renderer
 * picks the family-relevant subset at tailoring time based on the JD's
 * role family, so the user fills this once and it serves nursing AND
 * manual roles. Only positive ("held") items are shown on the CV —
 * a profile with no flags set produces no Registration & Licences section.
 */
export interface ProfileCredentials {
  // Healthcare / care
  ahpra_number?:          string;      // RN/EN/Midwife only — "NMW0001234567"
  ndis_screening?:        boolean;
  first_aid?:             boolean;     // HLTAID011
  cpr?:                   boolean;     // HLTAID009
  medication_competency?: boolean;
  flu_vaccination?:       boolean;
  covid_vaccination?:     boolean;
  // Manual / service
  white_card?:            boolean;     // construction
  forklift_licence?:      string;      // "" | "LF" | "LO"
  // Shared (both nursing & manual)
  drivers_licence?:       string;      // "" | "Open" | "Provisional" | "Learner"
  own_car?:               boolean;
  police_check?:          boolean;     // current national police check
  wwcc?:                  boolean;     // Working with Children Check
  wwcc_state?:            string;      // "" | "NSW" | "VIC" | "QLD" | "WA" | "SA" | "TAS" | "ACT" | "NT"
  work_rights?:           string;      // "" | "Citizen" | "PR" | "Visa with work rights"
  work_rights_hours?:     string;      // "" | "Full Time" | "Part Time"
  // Availability — opt-in shift preferences. Distinct from work_rights_hours
  // (what the visa allows) — this is which shifts the candidate WANTS. Only
  // surfaces on the CV when show_availability is true.
  availability?:          string[];    // subset of ["Full Time","Part Time","Casual"]
  show_availability?:     boolean;
}

const AVAILABILITY_OPTIONS = ["Full Time", "Part Time", "Casual"] as const;

/** Self-declared role-family selections that decide which add-on cards
 *  appear on the profile form. Multi-select — a candidate may apply for
 *  both nursing and admin roles, for example. */
export type RoleFamily = "tech" | "nursing" | "manual" | "general";

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
  /** Which role families the candidate applies for. Decides which add-on
   *  cards appear on this profile form. Surfaces on the CV via the matching
   *  role-family pack at tailoring time. */
  role_families?: RoleFamily[];
  /** Surfaces on tailored CVs only when the JD's role family is in the
   *  CREDENTIAL_FAMILIES set on the backend (currently nursing + manual). */
  credentials?:  ProfileCredentials;
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
  const [creds, setCreds]       = useState<ProfileCredentials>(initial?.credentials ?? {});
  const initFamilies = initial?.role_families ?? [];
  const [family, setFamily] = useState<RoleFamily | null>(initFamilies.length > 0 ? initFamilies[0] : null);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  function setField<K extends keyof ContactDetails>(k: K, v: string) {
    setCd((prev) => ({ ...prev, [k]: v }));
  }
  function setCred<K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) {
    setCreds((prev) => ({ ...prev, [k]: v }));
  }
  function toggleAvailability(v: string) {
    setCreds((prev) => {
      const cur = prev.availability ?? [];
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      return { ...prev, availability: next };
    });
  }

  const showTech    = family === "tech" || family === "general";
  const showNursing = family === "nursing";
  const showManual  = family === "manual";
  const anySelected = family !== null;
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
        body:    JSON.stringify({
          contact_details: { ...cd, projects, credentials: creds, role_families: family ? [family] : [] },
        }),
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
      {/* ── Contact Details (always shown) — LinkedIn is universal ── */}
      <div className="glass rounded-lg shadow-gold p-6 space-y-4">
        <div>
          <h2 className="label-luxury text-text-2">Contact Details</h2>
          <p className="mt-1 text-xs text-text-3">
            Used to stamp a clean contact line on every tailored CV. LinkedIn
            appears as a clickable link on every CV. Leave fields blank to omit them.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full Name"          value={cd.name        ?? ""} onChange={(v) => setField("name",        v)} placeholder="Jane Doe" />
          <Field label="Phone"              value={cd.phone       ?? ""} onChange={(v) => setField("phone",       v)} placeholder="+61 414 032 507" type="tel" />
          <Field label="Email"              value={cd.email       ?? ""} onChange={(v) => setField("email",       v)} placeholder="you@example.com" type="email" />
          <Field label="Suburb"             value={cd.suburb      ?? ""} onChange={(v) => setField("suburb",      v)} placeholder="Hurstville" />
          <Field label="State"              value={cd.address     ?? ""} onChange={(v) => setField("address",     v)} placeholder="NSW" />
          <Field label="Postcode"           value={cd.postcode    ?? ""} onChange={(v) => setField("postcode",    v)} placeholder="2220" />
          <Field label="LinkedIn URL"       value={cd.linkedin    ?? ""} onChange={(v) => setField("linkedin",    v)} placeholder="linkedin.com/in/yourname" />
          {/* Other link — label + URL share one row (label compact, URL wide). */}
          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
            <Field label="Other (label)" value={cd.other_label ?? ""} onChange={(v) => setField("other_label", v)} placeholder="e.g. Medium, Substack" />
            <Field label="Other (URL)"   value={cd.other_url   ?? ""} onChange={(v) => setField("other_url",   v)} placeholder="https://..." />
          </div>
        </div>

        <p className="text-xs text-text-3">
          On your CV: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">State | Phone | Email | LinkedIn</code>
          {(showTech) && <> · plus GitHub / Portfolio when you fill them below</>}
        </p>
      </div>

      {/* ── Role Family picker — single-select dropdown ── */}
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

      {/* ── Empty-state placeholder when no family is picked ── */}
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

      {/* ── Tech add-on (GitHub / Portfolio / Website) ── */}
      {showTech && (
        <div className="glass rounded-lg shadow-gold p-6 space-y-4">
          <div>
            <h2 className="label-luxury text-text-2">Tech / Engineering Links</h2>
            <p className="mt-1 text-xs text-text-3">
              Surface on the contact line for tech / engineering / data CVs.
              Leave blank to omit. Portfolio is preferred; Website is shown
              only when no Portfolio is set.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="GitHub URL"    value={cd.github    ?? ""} onChange={(v) => setField("github",    v)} placeholder="github.com/yourname" />
            <Field label="Portfolio URL" value={cd.portfolio ?? ""} onChange={(v) => setField("portfolio", v)} placeholder="yourname.dev" />
            <Field label="Website URL"   value={cd.website   ?? ""} onChange={(v) => setField("website",   v)} placeholder="(used only if no Portfolio)" />
          </div>
        </div>
      )}

      {/* ── Portfolio Projects card (tech-only — Projects are a tech-CV
            section; nursing/manual CVs don't carry a Projects block) ── */}
      {showTech && (
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
      )}

      {/* ── Healthcare / Care Credentials card (shown when nursing selected) ── */}
      {showNursing && (
        <div className="glass rounded-lg shadow-gold p-6 space-y-4">
          <div>
            <h2 className="label-luxury text-text-2">Healthcare / Care Credentials</h2>
            <p className="mt-1 text-xs text-text-3">
              Surfaces as a compact <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">Registration &amp; Licences</code> line
              on nursing / aged-care / disability / community-care CVs.
              Tick only what you hold — nothing negative is ever shown.
            </p>
          </div>

          {/* Registration + selectable identity */}
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

          {/* Held — checkboxes */}
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
      )}

      {/* ── Manual / Service Credentials card (shown when manual selected) ── */}
      {showManual && (
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

          {/* Identity */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="Forklift Licence"
              value={creds.forklift_licence ?? ""}
              onChange={(v) => setCred("forklift_licence", v)}
              options={["", "LF", "LO"]}
            />
            {/* These three already render in Healthcare when nursing is
                also selected — but we duplicate them here for manual-only
                users so they don't have to enable Healthcare to set them. */}
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

          {/* Held — checkboxes */}
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
      )}

      {/* ── Availability card (shown for nursing/manual — folds into the
            Registration & Licences line, no separate CV section) ── */}
      {(showNursing || showManual) && (
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
      )}

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
      <div className="select-chevron-wrap">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="select-chevron w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>{opt || "—"}</option>
          ))}
        </select>
        <ChevronDown className="h-4 w-4 text-text-2" />
      </div>
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

/**
 * Pill button — multi-select via toggle. Selected pills fill with the brand
 * colour; unselected stay bordered. Cleaner than checkboxes for a small
 * fixed set of choices like role families. Click toggles.
 */
function Pill({
  label, selected, onClick,
}: {
  label:    string;
  selected: boolean;
  onClick:  () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        selected
          ? "inline-flex items-center gap-1 rounded-full bg-[var(--brand)] px-3.5 py-1.5 text-sm font-medium text-[var(--brand-fg)] shadow-sm transition-shadow hover:glow-gold"
          : "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-sm font-medium text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors"
      }
    >
      {selected && <span aria-hidden>✓</span>}
      {label}
    </button>
  );
}

const FAMILY_LABELS: Record<RoleFamily, string> = {
  tech:    "Tech",
  nursing: "Healthcare",
  manual:  "Manual",
  general: "General",
};

function formatFamilyLabel(f: RoleFamily): string {
  return FAMILY_LABELS[f] ?? f;
}
