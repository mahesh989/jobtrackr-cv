"use client";

// Admin per-tier job-source selector (migration 064). Three tiers correspond
// to the user's subscription plan. The orchestrator resolves each user's plan
// at run time and reads the matching tier row.

import { useState } from "react";

type Source = "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever";
type Tier   = "weekly" | "monthly" | "unlimited";

interface TierConfig {
  tier:            Tier;
  enabled_sources: string[];
  adzuna_method:   "api" | "direct";
  seek_method:     "direct" | "actor";
}

interface Props {
  initial: TierConfig[];
}

const SOURCES: { id: Source; label: string }[] = [
  { id: "adzuna",     label: "Adzuna"     },
  { id: "seek",       label: "SEEK"       },
  { id: "careerjet",  label: "Careerjet"  },
  { id: "greenhouse", label: "Greenhouse" },
  { id: "lever",      label: "Lever"      },
];

const TIER_LABELS: Record<Tier, string> = {
  weekly:    "Weekly",
  monthly:   "Monthly",
  unlimited: "Unlimited",
};

const DEFAULTS: TierConfig[] = [
  { tier: "weekly",    enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  { tier: "monthly",   enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  { tier: "unlimited", enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
];

function seedTiers(initial: TierConfig[]): Record<Tier, TierConfig> {
  const map: Record<Tier, TierConfig> = {} as Record<Tier, TierConfig>;
  for (const def of DEFAULTS) {
    const found = initial.find((r) => r.tier === def.tier);
    map[def.tier] = found ?? def;
  }
  return map;
}

export function PlatformSourcesCard({ initial }: Props) {
  const [tiers,  setTiers]  = useState<Record<Tier, TierConfig>>(() => seedTiers(initial));
  const [dirty,  setDirty]  = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  const touch = () => { setDirty(true); setSaved(false); };

  function toggleSource(tier: Tier, id: Source) {
    setTiers((prev: Record<Tier, TierConfig>) => {
      const cfg = { ...prev[tier] };
      const set = new Set(cfg.enabled_sources as Source[]);
      if (set.has(id)) set.delete(id); else set.add(id);
      cfg.enabled_sources = Array.from(set);
      return { ...prev, [tier]: cfg };
    });
    touch();
  }

  function setAdzuna(tier: Tier, v: "api" | "direct") {
    setTiers((prev: Record<Tier, TierConfig>) => ({ ...prev, [tier]: { ...prev[tier], adzuna_method: v } }));
    touch();
  }

  function setSeek(tier: Tier, v: "direct" | "actor") {
    setTiers((prev: Record<Tier, TierConfig>) => ({ ...prev, [tier]: { ...prev[tier], seek_method: v } }));
    touch();
  }

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/admin/sources", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tiers: Object.values(tiers) }),
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

  const tierOrder: Tier[] = ["weekly", "monthly", "unlimited"];

  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {tierOrder.map((tier) => {
          const cfg = tiers[tier];
          const enabled = new Set(cfg.enabled_sources as Source[]);
          return (
            <div key={tier} className="rounded-md border border-border bg-[var(--surface-2)]/40 p-3 space-y-2">
              <p className="text-[12px] font-semibold text-text uppercase tracking-wide">{TIER_LABELS[tier]}</p>

              {SOURCES.map((s) => {
                const on = enabled.has(s.id);
                return (
                  <div key={s.id}>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleSource(tier, s.id)}
                        className="h-4 w-4 rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30"
                      />
                      <span className="text-[12px] text-text">{s.label}</span>
                    </label>

                    {on && s.id === "adzuna" && (
                      <div className="mt-1.5 ml-6 space-y-1">
                        <MethodRadio name={`adzuna-${tier}`} value="api"    checked={cfg.adzuna_method === "api"}    onChange={() => setAdzuna(tier, "api")}    label="API (teaser ~600 ch)" />
                        <MethodRadio name={`adzuna-${tier}`} value="direct" checked={cfg.adzuna_method === "direct"} onChange={() => setAdzuna(tier, "direct")} label="Direct — full JDs (actor)" />
                      </div>
                    )}
                    {on && s.id === "seek" && (
                      <div className="mt-1.5 ml-6 space-y-1">
                        <MethodRadio name={`seek-${tier}`} value="direct" checked={cfg.seek_method === "direct"} onChange={() => setSeek(tier, "direct")} label="Direct (free)" />
                        <MethodRadio name={`seek-${tier}`} value="actor"  checked={cfg.seek_method === "actor"}  onChange={() => setSeek(tier, "actor")}  label="Actor (Apify)" />
                      </div>
                    )}
                  </div>
                );
              })}
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
          {error  ? <span className="text-red-500">{error}</span>
          : saved  ? <span className="text-green-600 font-medium">✓ Saved — tier config updated</span>
          : dirty  ? <span className="text-text-2">Unsaved changes</span>
          : <span className="text-text-3">Source method varies by subscription tier.</span>}
        </span>
      </div>
    </div>
  );
}

function MethodRadio({ name, value, checked, onChange, label }: {
  name: string; value: string; checked: boolean; onChange: () => void; label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-text-2">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange}
        className="h-3.5 w-3.5 accent-[var(--brand)]" />
      {label}
    </label>
  );
}
