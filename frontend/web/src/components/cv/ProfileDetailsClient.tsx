"use client";

/**
 * ProfileDetailsClient — the per-USER tailoring overlay, unified into ONE state
 * + ONE save so it can be laid out as separate sections on the "My CV" page
 * (with the CV library sitting between Verticals and the rest) without the
 * sections clobbering each other.
 *
 * Why a context + single save: PATCH /api/user/preferences REPLACES
 * contact_details wholesale (it does not merge — see preferences/route.ts). If
 * each section saved independently they'd overwrite each other's unsaved edits.
 * So all profile fields (contact + verticals + credentials + references) live
 * in one provider and commit together via the save bar.
 *
 * Portfolio projects are NOT here — they live per-CV in the builder
 * (structured_cv.projects), rendered into normalized_cv_text.
 *
 * Sections are exported individually so the page can interleave the CV library
 * between them:
 *   <ProfileDetailsProvider initial activeCvId>
 *     <ContactSection /> <VerticalsSection />
 *     <CvLibraryClient />                         ← not part of this overlay
 *     <CredentialsSection /> <ReferencesSubSection />
 *     <ProfileSaveBar />
 *   </ProfileDetailsProvider>
 *
 * Field markup is ported from the former ProfileSettingsClient + ReferencesSection.
 */

import {
  createContext, useContext, useState, useMemo, type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  Plus, Trash2, Sparkles, UserCircle2, Layers,
  ShieldCheck, UserCheck,
} from "lucide-react";
import type { ContactDetails, ProfileCredentials, RoleFamily } from "@/components/cv/ProfileSettingsClient";
import type { Referee, ReferencesMode, ReferencesData } from "@/components/cv/ReferencesSection";

const MAX_REFEREES = 3;
const CONTACT_KEYS = [
  "name", "phone", "email", "address", "suburb", "postcode",
  "linkedin", "github", "website", "portfolio", "other_label", "other_url",
] as const;

function resolveInitialMode(data: ReferencesData | null | undefined): ReferencesMode {
  if (!data) return "none";
  if (data.mode) return data.mode;
  return data.available_on_request ? "on_request" : "details";
}

// ── Context ──────────────────────────────────────────────────────────────────

interface Ctx {
  cd:        ContactDetails;
  setField:  <K extends typeof CONTACT_KEYS[number]>(k: K, v: string) => void;
  family:    RoleFamily | null;
  setFamily: (f: RoleFamily | null) => void;
  creds:     ProfileCredentials;
  setCred:   <K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) => void;
  refMode:   ReferencesMode;
  setRefMode: (m: ReferencesMode) => void;
  referees:  Referee[];
  addReferee: () => void;
  removeReferee: (i: number) => void;
  patchReferee: (i: number, field: keyof Referee, value: string) => void;
  setReferees: (r: Referee[]) => void;
  activeCvId: string | null;
  dirty:     boolean;
  saving:    boolean;
  saved:     boolean;
  error:     string | null;
  showErrors: boolean;
  save:      () => Promise<void>;
}

/** Contact fields that must be filled before the profile can be saved. */
const REQUIRED_CONTACT_KEYS = ["name", "phone", "email", "suburb", "address", "postcode"] as const;

const ProfileCtx = createContext<Ctx | null>(null);
function useProfile(): Ctx {
  const c = useContext(ProfileCtx);
  if (!c) throw new Error("Profile sections must render inside <ProfileDetailsProvider>");
  return c;
}

export function ProfileDetailsProvider({
  initial, activeCvId, children,
}: {
  initial:    ContactDetails | null;
  activeCvId: string | null;
  children:   ReactNode;
}) {
  const router = useRouter();
  const init = initial ?? {};

  const initialContact = useMemo(() => {
    const out: ContactDetails = {};
    for (const k of CONTACT_KEYS) {
      const v = (init as Record<string, unknown>)[k];
      if (typeof v === "string") (out as Record<string, string>)[k] = v;
    }
    return out;
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const initRefs = (init as { references?: ReferencesData }).references;
  const [cd, setCd]           = useState<ContactDetails>(initialContact);
  const initFamilies          = init.role_families ?? [];
  const [family, setFamilySt] = useState<RoleFamily | null>(initFamilies.length > 0 ? initFamilies[0] : null);
  const [creds, setCreds]     = useState<ProfileCredentials>(init.credentials ?? {});
  const [refMode, setRefMode]   = useState<ReferencesMode>(resolveInitialMode(initRefs));
  const [referees, setReferees] = useState<Referee[]>(initRefs?.referees ?? []);

  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const touch = () => { setDirty(true); setSaved(false); };

  const ctx: Ctx = {
    cd,
    setField: (k, v) => { setCd((p) => ({ ...p, [k]: v })); touch(); },
    family,
    setFamily: (f) => { setFamilySt(f); touch(); },
    creds,
    setCred: (k, v) => { setCreds((p) => ({ ...p, [k]: v })); touch(); },
    refMode,
    setRefMode: (m) => { setRefMode(m); touch(); },
    referees,
    addReferee: () => { setReferees((p) => p.length >= MAX_REFEREES ? p : [...p, { name: "", job_title: "", company: "", email: "" }]); touch(); },
    removeReferee: (i) => { setReferees((p) => p.filter((_, idx) => idx !== i)); touch(); },
    patchReferee: (i, field, value) => { setReferees((p) => p.map((r, idx) => idx === i ? { ...r, [field]: value } : r)); touch(); },
    setReferees: (r) => { setReferees(r); touch(); },
    activeCvId,
    dirty, saving, saved, error, showErrors,
    save: async () => {
      // Validate mandatory fields before hitting the API.
      const missingContact = REQUIRED_CONTACT_KEYS.filter(
        (k) => !((cd as Record<string, string>)[k] ?? "").trim()
      );
      const noVertical = family === null;
      if (missingContact.length > 0 || noVertical) {
        setShowErrors(true);
        setError(
          noVertical && missingContact.length > 0
            ? "Fill the required contact fields and pick a role type."
            : noVertical
              ? "Select a role type before saving."
              : "Fill the required contact fields highlighted in red."
        );
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      setShowErrors(false);
      setSaving(true); setError(null); setSaved(false);
      const cleanedRefs = referees.filter((r) => r.name?.trim() || r.job_title?.trim() || r.company?.trim() || r.email?.trim());
      const payload = {
        ...cd,
        role_families: family ? [family] : [],
        credentials:   creds,
        references:    { mode: refMode, referees: cleanedRefs.slice(0, MAX_REFEREES) },
      };
      try {
        const res = await fetch("/api/user/preferences", {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ contact_details: payload }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setError(json.error ?? `Save failed (${res.status})`); return; }
        setReferees(cleanedRefs);
        setDirty(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
        router.refresh(); // re-renders skill labels + dependent sections
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
  };

  return <ProfileCtx.Provider value={ctx}>{children}</ProfileCtx.Provider>;
}

// ── Section shell ────────────────────────────────────────────────────────────

function SectionCard({
  icon: Icon, title, subtitle, children,
}: { icon: typeof UserCircle2; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)]/10 text-[var(--brand)]">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[14.5px] font-semibold text-text">{title}</h2>
          {subtitle && <p className="text-[12px] text-text-3 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

// ── Contact ──────────────────────────────────────────────────────────────────

export function ContactSection() {
  const { cd, setField, family, showErrors } = useProfile();
  const showTech = family === "tech" || family === "general";
  const invalid = (k: string) => showErrors && !((cd as Record<string, string>)[k] ?? "").trim();
  return (
    <SectionCard icon={UserCircle2} title="Contact details" subtitle="Stamped onto every tailored CV. Applies to all CVs. Fields marked * are required.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full Name"    value={cd.name        ?? ""} onChange={(v) => setField("name",        v)} placeholder="Jane Doe"          required invalid={invalid("name")} />
        <Field label="Phone"        value={cd.phone       ?? ""} onChange={(v) => setField("phone",       v)} placeholder="+61 414 032 507"   type="tel"   required invalid={invalid("phone")} />
        <Field label="Email"        value={cd.email       ?? ""} onChange={(v) => setField("email",       v)} placeholder="you@example.com"   type="email" required invalid={invalid("email")} />
        <Field label="Suburb"       value={cd.suburb      ?? ""} onChange={(v) => setField("suburb",      v)} placeholder="Hurstville"        required invalid={invalid("suburb")} />
        <Field label="State"        value={cd.address     ?? ""} onChange={(v) => setField("address",     v)} placeholder="NSW"               required invalid={invalid("address")} />
        <Field label="Postcode"     value={cd.postcode    ?? ""} onChange={(v) => setField("postcode",    v)} placeholder="2220"              required invalid={invalid("postcode")} />
        <Field label="LinkedIn URL" value={cd.linkedin    ?? ""} onChange={(v) => setField("linkedin",    v)} placeholder="https://linkedin.com/in/yourname" />
        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <Field label="Other (label)" value={cd.other_label ?? ""} onChange={(v) => setField("other_label", v)} placeholder="e.g. Medium, Substack" />
          <Field label="Other (URL)"   value={cd.other_url   ?? ""} onChange={(v) => setField("other_url",   v)} placeholder="https://..." />
        </div>
      </div>
      <p className="text-xs text-text-3">
        On your CV: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">State | Phone | Email | LinkedIn</code>
        {showTech && <> · plus GitHub / Portfolio when you fill them below</>}
      </p>
    </SectionCard>
  );
}

// ── Verticals ────────────────────────────────────────────────────────────────

const FAMILY_OPTIONS: { value: RoleFamily; label: string }[] = [
  { value: "tech",    label: "Tech / Data / Engineering" },
  { value: "nursing", label: "Healthcare / Nursing / Care" },
  { value: "manual",  label: "Manual / Service / Trades" },
  { value: "general", label: "Other / General" },
];

const AVAILABILITY_OPTIONS = ["Full Time", "Part Time", "Casual"] as const;

export function VerticalsSection() {
  const { family, setFamily, showErrors } = useProfile();
  const invalid = showErrors && family === null;
  return (
    <SectionCard icon={Layers} title="What roles are you applying for?" subtitle="Applies to all CVs. Drives your skill-section labels and which credential fields show. Required for CV analysis.">
      <div className="space-y-1.5">
        <select
          value={family ?? ""}
          onChange={(e) => setFamily(e.target.value ? e.target.value as RoleFamily : null)}
          className={`w-full rounded-md border bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 ${invalid ? "border-red-500" : "border-[var(--border)]"}`}
        >
          <option value="">— Select a role type —</option>
          {FAMILY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {invalid && <p className="text-xs text-red-600 font-medium">Select a role type to continue.</p>}
      </div>
    </SectionCard>
  );
}

// ── Credentials (nursing / manual) ───────────────────────────────────────────

export function CredentialsSection() {
  const { family, creds, setCred } = useProfile();
  const showNursing = family === "nursing";
  const showManual  = family === "manual";
  if (!showNursing && !showManual) return null;

  return (
    <SectionCard icon={ShieldCheck} title="Credentials & licences" subtitle="Applies to all CVs. Surfaces as a compact 'Registration & Licences' line on care / manual CVs. Tick only what you hold.">
      {/* Shared identity fields (render once) */}
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
            <CheckBox label="First Aid Certificate (HLTAID011)" checked={!!creds.first_aid}             onChange={(v) => setCred("first_aid", v)} />
            <CheckBox label="CPR Certificate (HLTAID009)"       checked={!!creds.cpr}                   onChange={(v) => setCred("cpr", v)} />
            <CheckBox label="Medication Competency Certificate" checked={!!creds.medication_competency} onChange={(v) => setCred("medication_competency", v)} />
            <CheckBox label="Current Influenza Vaccination"     checked={!!creds.flu_vaccination}       onChange={(v) => setCred("flu_vaccination", v)} />
            <CheckBox label="COVID-19 Vaccination (up to date)" checked={!!creds.covid_vaccination}     onChange={(v) => setCred("covid_vaccination", v)} />
          </>
        )}
      </div>
      <p className="text-xs text-text-3">
        On care / manual CVs: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">## Registration &amp; Licences</code> — held items only.
      </p>

      {/* Availability — opt-in. Renders as an italic line at the end of the
          Professional Summary section when "Show on my CV" is ticked. */}
      <div className="space-y-2 border-t border-border pt-4">
        <div>
          <p className="text-[13px] font-medium text-text">Availability</p>
          <p className="text-xs text-text-3">
            Which shifts you want. When shown, appears as an italic line at the end of your
            <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 mx-1">Professional Summary</code>
            (e.g. <span className="italic">Available: Casual, Part Time</span>). Off by default.
          </p>
        </div>
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
      </div>
    </SectionCard>
  );
}

// ── References ───────────────────────────────────────────────────────────────

const REF_MODES: { value: ReferencesMode; label: string; description: string }[] = [
  { value: "details",    label: "Include referee details", description: "Referee names, titles, and emails are printed on your CV." },
  { value: "on_request", label: "Available on request",    description: 'Your CV shows "References available on request."' },
  { value: "none",       label: "Don't include in CV",     description: "References section is omitted from your CV entirely." },
];

export function ReferencesSubSection() {
  const { refMode, setRefMode, referees, addReferee, removeReferee, patchReferee, setReferees, activeCvId } = useProfile();
  const [extracting, setExtracting]   = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extracted, setExtracted]     = useState<Referee[] | null>(null);

  async function handleExtract() {
    if (!activeCvId) return;
    setExtractError(null); setExtracting(true);
    try {
      const res = await fetch(`/api/cv/${activeCvId}/extract-references`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setExtractError(j.error ?? `Extraction failed (HTTP ${res.status})`);
        return;
      }
      const j = await res.json() as { referees: Referee[] };
      setExtracted(j.referees ?? []);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Network error — try again.");
    } finally {
      setExtracting(false);
    }
  }

  return (
    <SectionCard icon={UserCheck} title="References" subtitle="Applies to all CVs. Up to 3 referees.">
      <div className="space-y-2">
        {REF_MODES.map((opt) => (
          <label key={opt.value} className={`flex items-start gap-3 cursor-pointer rounded-lg border px-4 py-3 transition-colors ${refMode === opt.value ? "border-[var(--brand)]/50 bg-[var(--brand)]/5" : "border-border hover:bg-surface-2/60"}`}>
            <input type="radio" name="references-mode" value={opt.value} checked={refMode === opt.value} onChange={() => setRefMode(opt.value)} className="mt-0.5 h-4 w-4 accent-[var(--brand)] cursor-pointer shrink-0" />
            <div>
              <span className={`text-[13px] font-medium ${refMode === opt.value ? "text-[var(--brand)]" : "text-text"}`}>{opt.label}</span>
              <p className="text-[11px] text-text-3 mt-0.5">{opt.description}</p>
            </div>
          </label>
        ))}
      </div>

      {refMode === "details" && activeCvId && (
        <div className="rounded-lg border border-[var(--brand)]/20 bg-[var(--brand)]/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className="h-3.5 w-3.5 text-[var(--brand)]" />
                <span className="text-[12px] font-semibold text-text">Pre-fill from your active CV</span>
              </div>
              <p className="text-[11px] text-text-3 leading-relaxed">Use AI to extract referees already listed in your active CV. Nothing saves until you hit Save details.</p>
            </div>
            <button type="button" onClick={handleExtract} disabled={extracting} className="shrink-0 text-[12px] font-medium text-[var(--brand)] border border-[var(--brand)]/30 hover:bg-[var(--brand)]/10 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50">
              {extracting ? "Extracting…" : extracted ? "Re-extract" : "Extract from CV"}
            </button>
          </div>
          {extractError && <p className="text-[11px] text-red">{extractError}</p>}
          {extracted !== null && !extracting && (
            extracted.length === 0 ? (
              <p className="text-[11px] text-text-3 italic">No referees found in your CV. Add them manually below.</p>
            ) : (
              <div className="space-y-2 pt-1">
                <p className="text-[11px] text-text-3">Found {extracted.length} {extracted.length === 1 ? "referee" : "referees"}:</p>
                <ul className="space-y-1.5">
                  {extracted.map((r, i) => (
                    <li key={i} className="text-[11px] text-text-2 bg-surface rounded px-2 py-1.5 border border-border">
                      <span className="font-medium text-text">{r.name || "(unnamed)"}</span>
                      {r.job_title && <span> · {r.job_title}</span>}
                      {r.company && <span> · {r.company}</span>}
                      {r.email && <span className="text-text-3"> · {r.email}</span>}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => { setReferees(extracted.slice(0, MAX_REFEREES)); setRefMode("details"); }} className="text-[12px] font-medium text-[var(--brand)] hover:underline">Use these →</button>
              </div>
            )
          )}
        </div>
      )}

      {refMode === "details" && (
        <div className="space-y-3 pl-1">
          {referees.length === 0 && <p className="text-[12px] text-text-3 italic">No referees added yet.</p>}
          {referees.map((r, idx) => (
            <div key={idx} className="rounded-lg border border-border bg-surface p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-3">Referee {idx + 1}</span>
                <button type="button" onClick={() => removeReferee(idx)} className="rounded p-1 text-text-3 hover:bg-red-light hover:text-red transition-colors" aria-label="Remove referee">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Full name"              value={r.name      ?? ""} onChange={(v) => patchReferee(idx, "name", v)}      placeholder="e.g. Sarah Chen" />
                <Field label="Job title"              value={r.job_title ?? ""} onChange={(v) => patchReferee(idx, "job_title", v)} placeholder="e.g. Head of Nursing" />
                <Field label="Company / Organisation" value={r.company   ?? ""} onChange={(v) => patchReferee(idx, "company", v)}   placeholder="e.g. Anglicare" />
                <Field label="Email"                  value={r.email     ?? ""} onChange={(v) => patchReferee(idx, "email", v)}     placeholder="e.g. sarah@anglicare.org.au" type="email" />
              </div>
            </div>
          ))}
          {referees.length < MAX_REFEREES && (
            <button type="button" onClick={addReferee} className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--brand)] hover:underline">
              <Plus className="h-3.5 w-3.5" /> Add referee{referees.length > 0 ? ` (${referees.length}/${MAX_REFEREES})` : ""}
            </button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── Sticky save bar ──────────────────────────────────────────────────────────

export function ProfileSaveBar() {
  const { dirty, saving, saved, error, save } = useProfile();
  // Inline (not floating) so it never collides with the inline CV editor's own
  // fixed "Save & use this CV" toast when a library card is expanded.
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-shadow hover:opacity-90 hover:glow-gold disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save details"}
      </button>
      <span className="text-[12px] text-text-2">
        {error ? <span className="text-red">{error}</span>
          : saved ? <span className="text-green-600 font-medium">✓ Saved</span>
          : dirty ? "Unsaved changes — contact, verticals, credentials & references."
          : "Applies to every CV."}
      </span>
    </div>
  );
}

// ── Small inputs (ported) ────────────────────────────────────────────────────

function Field({ label, value, onChange, type = "text", placeholder, required = false, invalid = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean; invalid?: boolean }) {
  const border = invalid
    ? "border-red-500 focus:ring-red-500/20"
    : "border-[var(--border)] focus:ring-[var(--brand)]/30";
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
        {invalid && <span className="text-red-600 font-semibold ml-1.5">· required</span>}
      </label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full rounded-md border ${border} bg-[var(--surface)] px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2`} />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30">
        {options.map((opt) => <option key={opt} value={opt}>{opt || "—"}</option>)}
      </select>
    </div>
  );
}

function CheckBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 hover:bg-[var(--surface-2)] transition-colors">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30" />
      <span className="text-sm text-text">{label}</span>
    </label>
  );
}

function Pill({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={selected
        ? "inline-flex items-center gap-1 rounded-full bg-[var(--brand)] px-3.5 py-1.5 text-sm font-medium text-[var(--brand-fg)] shadow-sm transition-shadow hover:glow-gold"
        : "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-sm font-medium text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors"}>
      {selected && <span aria-hidden>✓</span>}
      {label}
    </button>
  );
}
