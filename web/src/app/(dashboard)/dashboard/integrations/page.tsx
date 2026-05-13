import { createClient }        from "@/lib/supabase/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { redirect }            from "next/navigation";
import { ApifyIntegrationCard } from "@/components/ApifyIntegrationCard";

export const metadata = { title: "Integrations — JobTrackr" };

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_integrations")
    .select("status, status_reason, quota_used_usd, quota_used_requests, quota_period_start, last_used_at, is_enabled")
    .eq("user_id", user.id)
    .eq("provider", "apify")
    .maybeSingle();

  const MONTHLY_BUDGET = 5.0;
  const quotaUsed      = (data?.quota_used_usd as number) ?? 0;
  const periodStart    = (data?.quota_period_start as string) ?? (new Date().toISOString().slice(0, 7) + "-01");
  const [year, month]  = periodStart.split("-").map(Number);
  const nextResetDate  = new Date(year, month, 1).toLocaleDateString("en-AU", {
    day: "numeric", month: "long", year: "numeric",
  });

  const initialData = data ? {
    connected:           true,
    status:              data.status as string,
    status_reason:       data.status_reason as string | null,
    quota_used_usd:      quotaUsed,
    quota_used_requests: (data.quota_used_requests as number) ?? 0,
    quota_remaining_usd: Math.max(0, MONTHLY_BUDGET - quotaUsed),
    monthly_budget_usd:  MONTHLY_BUDGET,
    quota_resets_on:     nextResetDate,
    last_used_at:        data.last_used_at as string | null,
    is_enabled:          (data.is_enabled as boolean) ?? true,
  } : null;

  return (
    <div className="min-h-full">
      {/* Page header — same pattern as edit profile */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">Integrations</h1>
        <p className="text-[12px] text-text-3 mt-0.5">
          Connect third-party services to unlock additional job sources.
        </p>
      </div>

      {/* Content */}
      <div className="px-6 py-5">
        <div className="flex gap-6 items-start">

          {/* Main card */}
          <div className="flex-1 min-w-0 max-w-2xl anim-in">
            <ApifyIntegrationCard initialData={initialData} />
          </div>

          {/* Tips panel */}
          <div className="w-72 shrink-0 hidden lg:block space-y-4 anim-in anim-delay-1">
            <div className="bg-surface border border-border rounded-md p-4 space-y-3">
              <p className="text-[12px] font-semibold text-text">Why connect Apify?</p>
              <ul className="space-y-2 text-[12px] text-text-2">
                <li className="flex gap-2">
                  <span className="text-green mt-0.5">✓</span>
                  <span>SEEK has 170,000+ active AU listings — far more than any other source</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-green mt-0.5">✓</span>
                  <span>Each user gets their own $5/month free credit — your quota is yours alone</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-green mt-0.5">✓</span>
                  <span>Daily incremental runs typically use $0.05–0.10 per month</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-green mt-0.5">✓</span>
                  <span>No credit card required for Apify free tier</span>
                </li>
              </ul>
            </div>

            <div className="bg-surface border border-border rounded-md p-4 space-y-2">
              <p className="text-[12px] font-semibold text-text">About your token</p>
              <p className="text-[12px] text-text-2 leading-relaxed">
                Your Apify token is encrypted with AES-256-GCM before storage. It is only decrypted inside
                the pipeline worker — never exposed to the browser or other users.
              </p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
