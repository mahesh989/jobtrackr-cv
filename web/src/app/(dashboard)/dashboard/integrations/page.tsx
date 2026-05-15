import { createClient }        from "@/lib/supabase/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { redirect }            from "next/navigation";
import { ApifyIntegrationCard } from "@/components/ApifyIntegrationCard";
import { AiKeyCard, type AiKeyProvider, type AiKeyState } from "@/components/cv/AiKeyCard";

export const metadata = { title: "Integrations — JobTrackr" };

const AI_PROVIDERS: AiKeyProvider[] = ["anthropic", "openai", "deepseek"];

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // ── Apify integration row (job-source) ────────────────────────────────────
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

  // ── AI provider keys (BYOK) ────────────────────────────────────────────────
  const { data: aiRows } = await admin
    .from("user_integrations")
    .select("provider, status, status_reason, last_validated_at, is_enabled, config")
    .eq("user_id", user.id)
    .in("provider", AI_PROVIDERS);

  interface IntegrationRow {
    provider:          AiKeyProvider;
    status:            string;
    status_reason:     string | null;
    last_validated_at: string | null;
    is_enabled:        boolean;
    config:            { model?: string } | null;
  }
  const byProvider = new Map<AiKeyProvider, AiKeyState>();
  for (const r of (aiRows ?? []) as IntegrationRow[]) {
    byProvider.set(r.provider, {
      connected:         true,
      status:            r.status,
      status_reason:     r.status_reason,
      last_validated_at: r.last_validated_at,
      is_enabled:        r.is_enabled,
      model:             r.config?.model ?? null,
    });
  }

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="text-[16px] font-semibold text-text">Integrations</h1>
          <p className="text-[12px] text-text-3 mt-0.5">
            Connect job sources and AI providers. All credentials are encrypted at rest with AES-256-GCM.
          </p>
        </div>

        {/* AI providers section */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">AI providers</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Bring your own key from at least one provider. The CV-tailoring pipeline
            prefers Anthropic, then OpenAI, then DeepSeek.
          </p>
          <div className="space-y-4">
            {AI_PROVIDERS.map((p) => (
              <AiKeyCard
                key={p}
                provider={p}
                initial={byProvider.get(p) ?? { connected: false }}
              />
            ))}
          </div>
        </section>

        {/* Job sources section */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">Job sources</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Third-party services that unlock additional job sources for discovery.
          </p>
          <ApifyIntegrationCard initialData={apifyInitial} />
        </section>

      </div>
    </div>
  );
}
