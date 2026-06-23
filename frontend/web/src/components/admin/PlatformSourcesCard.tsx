"use client";

// Admin-only platform job-source selector (migration 063). Whatever is enabled
// here applies to EVERY user's pipeline run — source selection + per-source
// method moved off the per-profile job-search form onto this single global row.

import { useState } from "react";

type Source = "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever";

interface Props {
  initial: {
    enabled_sources: string[];
    adzuna_method:   "api" | "direct";
    seek_method:     "direct" | "actor";
  };
}

const SOURCES: { id: Source; label: string; tag: string }[] = [
  { id: "adzuna",     label: "Adzuna",     tag: "Aggregator" },
  { id: "seek",       label: "SEEK",       tag: "Aggregator" },
  { id: "careerjet",  label: "Careerjet",  tag: "Aggregator" },
  { id: "greenhouse", label: "Greenhouse", tag: "ATS board" },
  { id: "lever",      label: "Lever",      tag: "ATS board" },
];

export function PlatformSourcesCard({ initial }: Props) {
  const [enabled, setEnabled]   = useState<Set<Source>>(new Set(initial.enabled_sources as Source[]));
  const [adzunaM, setAdzunaM]   = useState<"api" | "direct">(initial.adzuna_method);
  const [seekM,   setSeekM]     = useState<"direct" | "actor">(initial.seek_method);
  const [dirty,   setDirty]     = useState(false);
  const [saving,  setSaving]    = useState(false);
  const [saved,   setSaved]     = useState(false);
  const [error,   setError]     = useState<string | null>(null);

  const touch = () => { setDirty(true); setSaved(false); };
  const toggle = (id: Source) => {
    setEnabled((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    touch();
  };

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/admin/sources", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          enabled_sources: Array.from(enabled),
          adzuna_method:   adzunaM,
          seek_method:     seekM,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Save failed (${res.status})`); return;
      }
      setDirty(false); setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-3">
      <div className="space-y-2.5">
        {SOURCES.map((s) => {
          const on = enabled.has(s.id);
          return (
            <div key={s.id} className="rounded-md border border-border bg-[var(--surface-2)]/40 px-3 py-2.5">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(s.id)}
                  className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30"
                />
                <span className="text-[13px] font-medium text-text">{s.label}</span>
                <span className="text-[11px] text-text-3">{s.tag}</span>
              </label>

              {/* Per-source method, shown only for sources that have one + when on */}
              {on && s.id === "adzuna" && (
                <div className="mt-2 ml-6 flex items-center gap-3 text-[12px]">
                  <MethodRadio name="adzuna" value="direct" checked={adzunaM === "direct"} onChange={() => { setAdzunaM("direct"); touch(); }} label="Direct — full ~8k JDs (residential actor)" />
                  <MethodRadio name="adzuna" value="api"    checked={adzunaM === "api"}    onChange={() => { setAdzunaM("api");    touch(); }} label="API — fast, ~600-char teaser" />
                </div>
              )}
              {on && s.id === "seek" && (
                <div className="mt-2 ml-6 flex items-center gap-3 text-[12px]">
                  <MethodRadio name="seek" value="direct" checked={seekM === "direct"} onChange={() => { setSeekM("direct"); touch(); }} label="Direct — free (got-scraping)" />
                  <MethodRadio name="seek" value="actor"  checked={seekM === "actor"}  onChange={() => { setSeekM("actor");  touch(); }} label="Actor — Apify (paid fallback)" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-[13px] font-medium text-[var(--brand-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save sources"}
        </button>
        <span className="text-[12px]">
          {error ? <span className="text-red-500">{error}</span>
            : saved ? <span className="text-green-600 font-medium">✓ Saved — applies to all users</span>
            : dirty ? <span className="text-text-2">Unsaved changes</span>
            : <span className="text-text-3">Applies to every user&apos;s job runs.</span>}
        </span>
      </div>
    </div>
  );
}

function MethodRadio({ name, value, checked, onChange, label }: {
  name: string; value: string; checked: boolean; onChange: () => void; label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-text-2">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange}
        className="h-3.5 w-3.5 accent-[var(--brand)]" />
      {label}
    </label>
  );
}
