"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Contact details */}
      <div className="bg-surface border border-border rounded-md">
        <div className="px-5 py-4 border-b border-border bg-surface-2">
          <h2 className="text-[14px] font-semibold text-text">Contact details</h2>
          <p className="text-[12px] text-text-3 mt-0.5">
            Stamped onto every tailored CV's contact line. Leave any field blank
            to skip it.
          </p>
        </div>
        <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <Field label="Name"      value={cd.name ?? ""}      onChange={(v) => setField("name", v)} />
          <Field label="Email"     value={cd.email ?? ""}     onChange={(v) => setField("email", v)} type="email" />
          <Field label="Phone"     value={cd.phone ?? ""}     onChange={(v) => setField("phone", v)} type="tel" />
          <Field label="Address"   value={cd.address ?? ""}   onChange={(v) => setField("address", v)} />
          <Field label="LinkedIn"  value={cd.linkedin ?? ""}  onChange={(v) => setField("linkedin", v)} placeholder="https://linkedin.com/in/…" />
          <Field label="GitHub"    value={cd.github ?? ""}    onChange={(v) => setField("github", v)} placeholder="https://github.com/…" />
          <Field label="Portfolio" value={cd.portfolio ?? ""} onChange={(v) => setField("portfolio", v)} placeholder="https://yoursite.com" />
          <Field label="Website"   value={cd.website ?? ""}   onChange={(v) => setField("website", v)} placeholder="(if different from portfolio)" />
          <Field label="Other label" value={cd.other_label ?? ""} onChange={(v) => setField("other_label", v)} placeholder="e.g. Medium, Substack" />
          <Field label="Other URL"   value={cd.other_url ?? ""}   onChange={(v) => setField("other_url", v)} placeholder="https://…" />
        </div>
      </div>

      {/* Portfolio projects */}
      <div className="bg-surface border border-border rounded-md">
        <div className="px-5 py-4 border-b border-border bg-surface-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-text">Portfolio projects</h2>
            <p className="text-[12px] text-text-3 mt-0.5">
              Passed to the tailoring AI alongside your CV — it will surface relevant
              projects in the tailored CV when they fit the JD.
            </p>
          </div>
          <button onClick={addProject} className="gh-btn text-[12px]">+ Add project</button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {projects.length === 0 && (
            <p className="text-[12px] text-text-3 italic">No projects yet — click "Add project" to start.</p>
          )}
          {projects.map((proj, i) => (
            <div key={i} className="border border-border rounded-md p-3 bg-surface-2/40">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2">
                <div>
                  <label className="block text-[11px] text-text-2 mb-1">Name</label>
                  <input
                    value={proj.name ?? ""}
                    onChange={(e) => patchProject(i, "name", e.target.value)}
                    placeholder="e.g. CV Magic"
                    className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-2 mb-1">URL</label>
                  <input
                    value={proj.url ?? ""}
                    onChange={(e) => patchProject(i, "url", e.target.value)}
                    placeholder="https://…"
                    className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono"
                  />
                </div>
              </div>
              <div className="mt-2">
                <label className="block text-[11px] text-text-2 mb-1">Description (one line)</label>
                <input
                  value={proj.description ?? ""}
                  onChange={(e) => patchProject(i, "description", e.target.value)}
                  placeholder="What it does + the tech stack"
                  className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <button
                onClick={() => removeProject(i)}
                className="mt-2 text-[11px] text-text-3 hover:text-red"
              >
                Remove project
              </button>
            </div>
          ))}
        </div>
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
          className="gh-btn gh-btn-primary text-[13px]"
        >
          {busy ? "Saving…" : "Save profile"}
        </button>
        {savedFlash && <span className="text-[12px] text-green">✓ Saved</span>}
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", placeholder,
}: {
  label:       string;
  value:       string;
  onChange:    (v: string) => void;
  type?:       string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-[11px] text-text-2 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
    </div>
  );
}
