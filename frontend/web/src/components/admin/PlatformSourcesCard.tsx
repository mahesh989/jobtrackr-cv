"use client";

// Per-tier job-source reference matrix (read-only since migration 064).
// Behavior is seeded in platform_source_tiers and fixed by code — not
// editable at runtime. This card documents what each tier receives.

type Tier = "weekly" | "monthly" | "unlimited";

interface TierConfig {
  tier:            Tier;
  enabled_sources: string[];
  adzuna_method:   "api" | "direct";
  seek_method:     "direct" | "actor";
}

interface Props {
  initial: TierConfig[];
}

const TIER_LABELS: Record<Tier, string> = {
  weekly:    "Weekly",
  monthly:   "Monthly",
  unlimited: "Unlimited",
};

const SOURCE_LABELS: Record<string, string> = {
  adzuna:    "Adzuna",
  seek:      "SEEK",
  careerjet: "Careerjet",
};

function Chip({ label, variant = "neutral" }: { label: string; variant?: "green" | "amber" | "blue" | "neutral" }) {
  const cls = {
    green:   "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber:   "bg-amber-50  text-amber-700  border-amber-200",
    blue:    "bg-blue-50   text-blue-700   border-blue-200",
    neutral: "bg-[var(--surface-2)] text-text-2 border-border",
  }[variant];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

export function PlatformSourcesCard({ initial }: Props) {
  const tierOrder: Tier[] = ["weekly", "monthly", "unlimited"];

  const byTier: Record<Tier, TierConfig> = {} as Record<Tier, TierConfig>;
  const DEFAULTS: TierConfig[] = [
    { tier: "weekly",    enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
    { tier: "monthly",   enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
    { tier: "unlimited", enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
  ];
  for (const def of DEFAULTS) {
    const row = initial.find((r) => r.tier === def.tier);
    byTier[def.tier] = row ?? def;
  }

  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-4">
      <p className="text-[11px] text-text-3">
        Source behavior is fixed per subscription tier and seeded in{" "}
        <code className="font-mono text-[10px]">platform_source_tiers</code>.
        Careerjet uses the free v4 API for all tiers (actor dormant).
        Only Unlimited runs paid Apify actors (SEEK listings fallback + Adzuna full-JD enrichment).
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {tierOrder.map((tier) => {
          const cfg     = byTier[tier];
          const enabled = new Set(cfg.enabled_sources);
          const isUnlimited = tier === "unlimited";
          return (
            <div key={tier} className="rounded-md border border-border bg-[var(--surface-2)]/40 p-3 space-y-2.5">
              <p className="text-[12px] font-semibold text-text uppercase tracking-wide">
                {TIER_LABELS[tier]}
              </p>

              {/* Sources enabled */}
              <div className="space-y-1">
                {["adzuna", "seek", "careerjet"].map((s) => (
                  <div key={s} className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-text">{SOURCE_LABELS[s] ?? s}</span>
                    <Chip label={enabled.has(s) ? "enabled" : "off"} variant={enabled.has(s) ? "green" : "neutral"} />
                  </div>
                ))}
              </div>

              <div className="border-t border-border/60 pt-2 space-y-1.5">
                {/* Adzuna method */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-text-3">Adzuna JDs</span>
                  {cfg.adzuna_method === "direct"
                    ? <Chip label="full JD (actor)" variant="blue" />
                    : <Chip label="API teasers" variant="neutral" />
                  }
                </div>

                {/* SEEK method */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-text-3">SEEK listings</span>
                  <Chip label="direct (free)" variant="green" />
                </div>

                {/* SEEK Apify fallback */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-text-3">SEEK Apify fallback</span>
                  {isUnlimited
                    ? <Chip label="on failure" variant="amber" />
                    : <Chip label="never" variant="neutral" />
                  }
                </div>

                {/* Paid Apify */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-text-3">Paid Apify</span>
                  {isUnlimited
                    ? <Chip label="yes" variant="amber" />
                    : <Chip label="never" variant="green" />
                  }
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
