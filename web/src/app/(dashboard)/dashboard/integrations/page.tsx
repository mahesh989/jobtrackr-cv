import { createClient }        from "@/lib/supabase/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { redirect }            from "next/navigation";
import { ApifyIntegrationCard }  from "@/components/ApifyIntegrationCard";
import { EmailIntegrationCard }  from "@/components/email/EmailIntegrationCard";
import { ProviderPicker, type ProviderId } from "@/components/ProviderPicker";

export const metadata = { title: "Integrations — JobTrackr" };

const AI_PROVIDERS: ProviderId[] = ["anthropic", "openai", "deepseek"];

const OAUTH_ERROR_LABELS: Record<string, string> = {
  invalid_state:           "Security check failed — please try again.",
  no_code:                 "Google didn't return an authorization code.",
  token_exchange_failed:   "Couldn't exchange the code for a token. Check your GOOGLE_CLIENT_SECRET / MICROSOFT_CLIENT_SECRET.",
  missing_tokens:          "OAuth completed but no refresh token was returned. Re-run consent (refresh tokens require offline_access + prompt=consent).",
  access_denied:           "You declined the consent screen.",
};

function describeError(key: string): string {
  // save_failed:<reason> — surface the underlying message verbatim
  if (key.startsWith("save_failed:")) return `Token save failed — ${key.slice("save_failed:".length)}`;
  return OAUTH_ERROR_LABELS[key] ?? `Error: ${key}`;
}

interface PageProps {
  searchParams: Promise<{
    email_connected?: "google" | "outlook";
    email_error?:     string;
  }>;
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const sp        = await searchParams;
  const connected = sp.email_connected ?? null;
  const errorKey  = sp.email_error     ?? null;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // ── Apify integration ─────────────────────────────────────────────────────
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

  // ── AI provider keys ──────────────────────────────────────────────────────
  const { data: aiRows } = await admin
    .from("user_integrations")
    .select("provider, status, status_reason, last_validated_at, config")
    .eq("user_id", user.id)
    .in("provider", AI_PROVIDERS);

  interface IntegrationRow {
    provider:          ProviderId;
    status:            string;
    status_reason:     string | null;
    last_validated_at: string | null;
    config:            { model?: string } | null;
  }

  const byProvider = new Map<ProviderId, {
    connected: boolean; statusReason: string | null;
    lastValidated: string | null; model: string | null;
  }>();

  for (const r of (aiRows ?? []) as IntegrationRow[]) {
    byProvider.set(r.provider, {
      connected:     true,
      statusReason:  r.status_reason,
      lastValidated: r.last_validated_at,
      model:         r.config?.model ?? null,
    });
  }

  // ── Email integration ─────────────────────────────────────────────────────
  const { data: emailRow } = await admin
    .from("email_integrations")
    .select("provider, from_address")
    .eq("user_id", user.id)
    .maybeSingle();

  const emailConnected = emailRow?.from_address
    ? { provider: emailRow.provider as "google" | "microsoft", from_address: emailRow.from_address as string }
    : null;

  const pickerProviders = AI_PROVIDERS.map((id) => {
    const row = byProvider.get(id);
    return {
      id,
      connected:     row?.connected     ?? false,
      statusReason:  row?.statusReason  ?? null,
      lastValidated: row?.lastValidated ?? null,
      model:         row?.model         ?? null,
    };
  });

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="page-title text-text">Integrations</h1>
          <p className="page-subtitle">
            Connect job sources and AI providers. All credentials are encrypted at rest with AES-256-GCM.
          </p>
        </div>

        {/* OAuth result banner ── shown for one page-load after callback */}
        {connected && (
          <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-3">
            <p className="text-[13px] font-medium text-emerald-800 dark:text-emerald-300">
              ✓ {connected === "google" ? "Gmail" : "Outlook"} connected successfully
            </p>
            <p className="text-[12px] text-emerald-700 dark:text-emerald-400 mt-0.5">
              You can now send application emails from the Applications page.
            </p>
          </div>
        )}
        {errorKey && (
          <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-4 py-3">
            <p className="text-[13px] font-medium text-red-800 dark:text-red-300">
              ✗ Email connection failed
            </p>
            <p className="text-[12px] text-red-700 dark:text-red-400 mt-0.5">
              {describeError(errorKey)}
            </p>
          </div>
        )}

        {/* AI providers — unified picker */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">AI providers</h2>
          <p className="text-[12px] text-text-3 mb-4">
            Bring your own key. Click a provider to expand, paste your key, choose a model,
            then hit Connect. Click the radio dot to set it as preferred for all analyses.
          </p>
          <ProviderPicker providers={pickerProviders} />
        </section>

        {/* Email account */}
        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">Email account</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Connect Gmail or Outlook to send application emails with your cover letter
            and tailored CV directly from the Applications page.
          </p>
          <EmailIntegrationCard
            connected={emailConnected}
            googleConfigured={!!process.env.GOOGLE_CLIENT_ID}
            microsoftConfigured={!!process.env.MICROSOFT_CLIENT_ID}
          />
        </section>

        {/* Job sources */}
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
