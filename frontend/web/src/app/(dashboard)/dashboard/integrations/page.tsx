import { createClient }        from "@/lib/supabase/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { redirect }            from "next/navigation";
import { ApifyIntegrationCard }  from "@/components/ApifyIntegrationCard";
import { PlatformSourcesCard }   from "@/components/admin/PlatformSourcesCard";

export const metadata = { title: "Integrations — JobTrackr" };

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Founder/admin only — source selection + Apify quota are operator concerns.
  // The user-facing email-account connect lives at My CV → Email account.
  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard/cv");

  const admin = createAdminClient();

  // ── Platform job-source config (admin-controlled, applies to all users) ─────
  const { data: srcRow } = await admin
    .from("platform_sources")
    .select("enabled_sources, adzuna_method, seek_method")
    .eq("id", 1)
    .maybeSingle();
  const sources = {
    enabled_sources: (srcRow?.enabled_sources as string[] | null) ?? ["adzuna", "seek", "careerjet"],
    adzuna_method:   (srcRow?.adzuna_method as "api" | "direct" | null) ?? "direct",
    seek_method:     (srcRow?.seek_method as "direct" | "actor" | null) ?? "direct",
  };

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
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="page-title text-text">Integrations</h1>
          <p className="page-subtitle">
            Choose which job sources every user&apos;s pipeline scans, and manage the
            Apify quota. Credentials are encrypted at rest (AES-256-GCM). Manage the
            platform AI provider at{" "}
            <a href="/dashboard/admin/ai-settings" className="text-[var(--brand)] hover:underline">
              Admin → AI provider
            </a>.
          </p>
        </div>

        {/* Job sources — global selection (applies to all users) */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">Job sources</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Which job boards to scan, and the method per source. This applies to
            <strong className="text-text-2"> every user&apos;s</strong> runs — users no longer
            choose sources per search profile.
          </p>
          <PlatformSourcesCard initial={sources} />
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
