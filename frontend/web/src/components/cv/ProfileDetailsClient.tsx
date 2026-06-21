"use client";

/**
 * ProfileDetailsClient — the per-USER tailoring overlay, unified into ONE state
 * + ONE save so it can be laid out as separate sections on the "My CV" page
 * (with the CV library sitting between Verticals and Projects) without the
 * sections clobbering each other.
 *
 * Why a context + single save: PATCH /api/user/preferences REPLACES
 * contact_details wholesale (it does not merge — see preferences/route.ts). If
 * each section saved independently they'd overwrite each other's unsaved edits.
 * So all profile fields (contact + verticals + projects + credentials +
 * references) live in one provider and commit together via the sticky save bar.
 *
 * Sections are exported individually so the page can interleave the CV library
 * between them:
 *   <ProfileDetailsProvider initial activeCvId>
 *     <ContactSection /> <VerticalsSection />
 *     <CvLibraryClient />                         ← not part of this overlay
 *     <ProjectsSection /> <CredentialsSection /> <ReferencesSubSection />
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
  Plus, Trash2, ExternalLink, Sparkles, UserCircle2, Layers,
  FolderGit2, ShieldCheck, UserCheck,
} from "lucide-react";
import type { ContactDetails, ProfileCredentials, RoleFamily } from "@/components/cv/ProfileSettingsClient";
import type { Referee, ReferencesMode, ReferencesData } from "@/components/cv/ReferencesSection";

interface Project { name?: string; url?: string; description?: string }

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
  families:  RoleFamily[];
  toggleFamily: (f: RoleFamily) => void;
  projects:  Project[];
  addProject: () => void;
  removeProject: (i: number) => void;
  patchProject: (i: number, field: keyof Project, value: string) => void;
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
  save:      () => Promise<void>;
}

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
  const [cd, setCd]             = useState<ContactDetails>(initialContact);
  const [families, setFamilies] = useState<RoleFamily[]>(init.role_families ?? []);
  const [projects, setProjects] = useState<Project[]>(init.projects ?? []);
  const [creds, setCreds]       = useState<ProfileCredentials>(init.credentials ?? {});
  const [refMode, setRefMode]   = useState<ReferencesMode>(resolveInitialMode(initRefs));
  const [referees, setReferees] = useState<Referee[]>(initRefs?.referees ?? []);

  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const touch = () => { setDirty(true); setSaved(false); };

  const ctx: Ctx = {
    cd,
    setField: (k, v) => { setCd((p) => ({ ...p, [k]: v })); touch(); },
    families,
    toggleFamily: (f) => { setFamilies((p) => p.includes(f) ? p.filter((x) => x !== f) : [...p, f]); touch(); },
    projects,
    addProject: () => { setProjects((p) => [...p, { name: "", url: "", description: "" }]); touch(); },
    removeProject: (i) => { setProjects((p) => p.filter((_, idx) => idx !== i)); touch(); },
    patchProject: (i, field, value) => { setProjects((p) => p.map((pr, idx) => idx === i ? { ...pr, [field]: value } : pr)); touch(); },
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
    dirty, saving, saved, error,
    save: async () => {
      setSaving(true); setError(null); setSaved(false);
      const cleanedRefs = referees.filter((r) => r.name?.trim() || r.job_title?.trim() || r.company?.trim() || r.email?.trim());
      const payload = {
        ...cd,
        role_families: families,
        projects,
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
  const { cd, setField, families } = useProfile();
  const showTech = families.includes("tech") || families.includes("general");
  return (
    <SectionCard icon={UserCircle2} title="Contact details" subtitle="Stamped onto every tailored CV. Applies to all CVs. Leave fields blank to omit them.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full Name"    value={cd.name        ?? ""} onChange={(v) => setField("name",        v)} placeholder="Jane Doe" />
        <Field label="Phone"        value={cd.phone       ?? ""} onChange={(v) => setField("phone",       v)} placeholder="+61 414 032 507" type="tel" />
        <Field label="Email"        value={cd.email       ?? ""} onChange={(v) => setField("email",       v)} placeholder="you@example.com" type="email" />
        <Field label="Suburb"       value={cd.suburb      ?? ""} onChange={(v) => setField("suburb",      v)} placeholder="Hurstville" />
        <Field label="State"        value={cd.address     ?? ""} onChange={(v) => setField("address",     v)} placeholder="NSW" />
        <Field label="Postcode"     value={cd.postcode    ?? ""} onChange={(v) => setField("postcode",    v)} placeholder="2220" />
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

const FAMILY_LABELS: Record<RoleFamily, string> = { tech: "Tech", nursing: "Healthcare", manual: "Manual", general: "General" };

export function VerticalsSection() {
  const { families, toggleFamily } = useProfile();
  return (
    <SectionCard icon={Layers} title="What roles are you applying for?" subtitle="Applies to all CVs. Drives your skill-section labels and which credential/project fields show.">
      <div className="flex flex-wrap gap-2">
        <Pill label="Tech / Data / Engineering"   selected={families.includes("tech")}    onClick={() => toggleFamily("tech")} />
        <Pill label="Healthcare / Nursing / Care" selected={families.includes("nursing")} onClick={() => toggleFamily("nursing")} />
        <Pill label="Manual / Service / Trades"   selected={families.includes("manual")}  onClick={() => toggleFamily("manual")} />
        <Pill label="Other / General"             selected={families.includes("general")} onClick={() => toggleFamily("general")} />
      </div>
      {families.length > 0 && (
        <p className="text-xs text-text-3">
          Showing fields for: <span className="font-medium text-text-2">{families.map((f) => FAMILY_LABELS[f] ?? f).join(", ")}</span>
        </p>
      )}
    </SectionCard>
  );
}

// ── Projects (tech only) ─────────────────────────────────────────────────────

export function ProjectsSection() {
  const { families, projects, addProject, removeProject, patchProject } = useProfile();
  const showTech = families.includes("tech") || families.includes("general");
  if (!showTech) return null;
  return (
    <SectionCard icon={FolderGit2} title="Portfolio projects" subtitle="Tech CVs only. Passed to the AI at tailoring time — it references relevant projects per role.">
      <div className="space-y-3">
        {projects.map((proj, i) => (
          <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-text-2">Project {i + 1}</span>
              <button onClick={() => removeProject(i)} className="rounded p-1 hover:bg-red-light hover:text-red transition-colors" aria-label="Remove project">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Name" value={proj.name ?? ""} onChange={(v) => patchProject(i, "name", v)} placeholder="e.g. CV Magic" />
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
                    <a href={proj.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-text-3 hover:text-[var(--brand)]" aria-label="Open project URL">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>
              </div>
            </div>
            <Field label="One-line description (optional)" value={proj.description ?? ""} onChange={(v) => patchProject(i, "description", v)} placeholder="e.g. AI-powered CV tailoring tool built with Next.js and FastAPI" />
          </div>
        ))}
      </div>
      <button onClick={addProject} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm font-medium text-text-2 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors">
        <Plus className="h-4 w-4" /> Add project
      </button>
    </SectionCard>
  );
}

// ── Credentials (nursing / manual) ───────────────────────────────────────────

export function CredentialsSection() {
  const { families, creds, setCred } = useProfile();
  const showNursing = families.includes("nursing");
  const showManual  = families.includes("manual");
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
          : dirty ? "Unsaved changes — contact, verticals, projects, credentials & references."
          : "Applies to every CV."}
      </span>
    </div>
  );
}

// ── Small inputs (ported) ────────────────────────────────────────────────────

function Field({ label, value, onChange, type = "text", placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-text-2">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30" />
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
