"use client";

// Admin-only platform job-source selector (migration 064 — platform_source_tiers).
// Source config now varies by subscription tier: weekly / monthly / unlimited.
// Each column is independently saveable.

import { useState } from "react";

type Source  = "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever" | "agedcare" | "radancy" | "avature" | "agedcare_dayforce" | "successfactors";
type Tier    = "weekly" | "monthly" | "unlimited";
type AdzunaM = "api" | "direct";
type SeekM   = "direct" | "actor";

interface TierConfig {
  enabled_sources: string[];
  adzuna_method:   AdzunaM;
  seek_method:     SeekM;
}

interface Props {
  initial: Record<Tier, TierConfig>;
}

const TIERS: { id: Tier; label: string; badge?: string }[] = [
  { id: "weekly",    label: "Weekly",    badge: "A$9.99/wk" },
  { id: "monthly",   label: "Monthly",   badge: "A$19.99/mo" },
  { id: "unlimited", label: "Unlimited", badge: "A$29.99/mo" },
];

const SOURCES: { id: Source; label: string; tag: string }[] = [
  { id: "adzuna",     label: "Adzuna",     tag: "API + actor" },
  { id: "seek",       label: "SEEK",       tag: "direct + actor" },
  { id: "careerjet",  label: "Careerjet",  tag: "v4 API" },
  { id: "greenhouse", label: "Greenhouse", tag: "API" },
  { id: "lever",      label: "Lever",      tag: "API" },
  { id: "agedcare",          label: "Aged Care",            tag: "Workday direct" },
  { id: "radancy",           label: "Aged Care — Bupa",     tag: "Radancy direct" },
  { id: "avature",           label: "Aged Care — Regis",    tag: "Avature direct" },
  { id: "agedcare_dayforce", label: "Aged Care — Uniting",  tag: "Dayforce direct" },
  { id: "successfactors",    label: "Aged Care — Aus Unity", tag: "SuccessFactors direct" },
];

function MethodRadio({ name, value, checked, onChange, label }: {
  name: string; value: string; checked: boolean; onChange: () => void; label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="h-3.5 w-3.5" />
      <span className="text-text-2">{label}</span>
    </label>
  );
}

export function PlatformSourcesCard({ initial }: Props) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {TIERS.map((t) => (
        <TierColumn key={t.id} tier={t} initial={initial[t.id]} />
      ))}
    </div>
  );
}

function TierColumn({
  tier,
  initial,
}: {
  tier: { id: Tier; label: string; badge?: string };
  initial: TierConfig;
}) {
  const [enabled, setEnabled] = useState<Set<Source>>(new Set(initial.enabled_sources as Source[]));
  const [adzunaM, setAdzunaM] = useState<AdzunaM>(initial.adzuna_method);
  const [seekM,   setSeekM]   = useState<SeekM>(initial.seek_method);
  const [dirty,   setDirty]   = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const touch = () => { setDirty(true); setSaved(false); };

  const toggle = (id: Source) => {
    setEnabled((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    touch();
  };

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/admin/sources", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          tier:            tier.id,
          enabled_sources: Array.from(enabled),
          adzuna_method:   adzunaM,
          seek_method:     seekM,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Save failed (${res.status})`);
        return;
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
      {/* Tier header */}
      <div>
        <p className="text-[13px] font-semibold text-text">{tier.label}</p>
        {tier.badge && <p className="text-[11px] text-text-3">{tier.badge}</p>}
      </div>

      {/* Source rows */}
      <div className="space-y-2">
        {SOURCES.map((s) => {
          const on = enabled.has(s.id);
          return (
            <div key={s.id} className="rounded-md border border-border bg-[var(--surface-2)]/40 px-3 py-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(s.id)}
                  className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30"
                />
                <span className="text-[12px] font-medium text-text">{s.label}</span>
                <span className="text-[10px] text-text-3">{s.tag}</span>
              </label>

              {on && s.id === "adzuna" && (
                <div className="mt-1.5 ml-6 space-y-0.5 text-[11px]">
                  <MethodRadio name={`${tier.id}-adzuna`} value="api"    checked={adzunaM === "api"}    onChange={() => { setAdzunaM("api");    touch(); }} label="API — fast teaser" />
                  <MethodRadio name={`${tier.id}-adzuna`} value="direct" checked={adzunaM === "direct"} onChange={() => { setAdzunaM("direct"); touch(); }} label="Direct — full JD (actor)" />
                </div>
              )}
              {on && s.id === "seek" && (
                <div className="mt-1.5 ml-6 space-y-0.5 text-[11px]">
                  <MethodRadio name={`${tier.id}-seek`} value="direct" checked={seekM === "direct"} onChange={() => { setSeekM("direct"); touch(); }} label="Direct — free" />
                  <MethodRadio name={`${tier.id}-seek`} value="actor"  checked={seekM === "actor"}  onChange={() => { setSeekM("actor");  touch(); }} label="Actor — Apify (paid)" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save row */}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-[12px] font-medium text-[var(--brand-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <span className="text-[11px]">
          {error  ? <span className="text-red-500">{error}</span>
            : saved  ? <span className="text-green-600 font-medium">✓ Saved</span>
            : dirty  ? <span className="text-text-2">Unsaved</span>
            : null}
        </span>
      </div>
    </div>
  );
}
