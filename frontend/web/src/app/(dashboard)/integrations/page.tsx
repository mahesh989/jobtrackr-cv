import { createClient }        from "@/lib/supabase/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { ADMIN_ROLES }         from "@/lib/constants";
import { redirect }            from "next/navigation";
import { ApifyIntegrationCard }  from "@/features/integrations/ApifyIntegrationCard";
import { PlatformSourcesCard }   from "@/features/admin/PlatformSourcesCard";

export const metadata = { title: "Integrations — JobTrackr" };

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Founder/admin only — source selection + Apify quota are operator concerns.
  // The user-facing email-account connect lives at My CV → Email account.
  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !(ADMIN_ROLES as readonly string[]).includes(me.role as string)) redirect("/cv");

  const admin = createAdminClient();

  // ── Platform job-source config (per subscription tier, migration 064) ────────
  const { data: tierRows } = await admin
    .from("platform_source_tiers")
    .select("tier, enabled_sources, adzuna_method, seek_method");

  type TierConfig = { enabled_sources: string[]; adzuna_method: "api" | "direct"; seek_method: "direct" | "actor" };
  const tierDefaults: Record<string, TierConfig> = {
    weekly:    { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
    monthly:   { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
    unlimited: { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
  };
  const sources = { ...tierDefaults } as Record<string, TierConfig>;
  for (const row of (tierRows ?? []) as Array<{ tier: string; enabled_sources: string[] | null; adzuna_method: string | null; seek_method: string | null }>) {
    const def = tierDefaults[row.tier] ?? tierDefaults.weekly;
    sources[row.tier] = {
      enabled_sources: (row.enabled_sources as string[] | null) ?? def.enabled_sources,
      adzuna_method:   (row.adzuna_method as "api" | "direct" | null)   ?? def.adzuna_method,
      seek_method:     (row.seek_method   as "direct" | "actor" | null) ?? def.seek_method,
    };
  }

  // ── Apify integration (quota) ──────────────────────────────────────────────
  const { data: apify } = await admin
    .from("user_integrations")
    .select("status, status_reason, quota_used_usd, quota_used_requests, quota_period_start, last_used_at, is_enabled")
    .eq("user_id", user.id)
    .eq("provider", "apify")
    .maybeSingle();

  const MONTHLY_BUDGET = 5.0;
  const quotaUsed      = (apify?.quota_used_usd as number) ?? 0;
  const periodStart    = (apify?.quota_period_start as string) ?? (new Date().toISOString().slice(0, 7) + "-01");
  const [year, month]  = periodStart.split("-").map(Number);
  const nextResetDate  = new Date(year, month, 1).toLocaleDateString("en-AU", {
    day: "numeric", month: "long", year: "numeric",
  });

  const apifyInitial = apify ? {
    connected:           true,
    status:              apify.status as string,
    status_reason:       apify.status_reason as string | null,
    quota_used_usd:      quotaUsed,
    quota_used_requests: (apify.quota_used_requests as number) ?? 0,
    quota_remaining_usd: Math.max(0, MONTHLY_BUDGET - quotaUsed),
    monthly_budget_usd:  MONTHLY_BUDGET,
    quota_resets_on:     nextResetDate,
    last_used_at:        apify.last_used_at as string | null,
    is_enabled:          (apify.is_enabled as boolean) ?? true,
  } : null;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="page-title text-text">Integrations</h1>
          <p className="page-subtitle">
            Choose which job sources every user&apos;s pipeline scans, and manage the
            Apify quota. Credentials are encrypted at rest (AES-256-GCM). Manage the
            platform AI provider at{" "}
            <a href="/admin/ai-settings" className="text-[var(--brand)] hover:underline">
              Admin → AI provider
            </a>.
          </p>
        </div>

        {/* Job sources — per-tier editable config */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">Job sources</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Which job boards to scan, and the fetch method per source — configured
            separately for each <strong className="text-text-2">subscription tier</strong>.
            Users on higher tiers get richer JDs (Adzuna direct via actor).
          </p>
          <PlatformSourcesCard initial={sources as Parameters<typeof PlatformSourcesCard>[0]["initial"]} />
        </section>

        {/* Apify quota */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">Apify quota</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Residential-proxy + actor usage for SEEK / Adzuna / Careerjet full-JD enrichment.
          </p>
          <ApifyIntegrationCard initialData={apifyInitial} />
        </section>
      </div>
    </div>
  );
}
