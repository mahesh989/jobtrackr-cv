"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ExternalLink } from "lucide-react";

interface Project {
  name?:        string;
  url?:         string;
  description?: string;
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
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  function setField<K extends keyof ContactDetails>(k: K, v: string) {
    setCd((prev) => ({ ...prev, [k]: v }));
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
        body:    JSON.stringify({ contact_details: { ...cd, projects } }),
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
