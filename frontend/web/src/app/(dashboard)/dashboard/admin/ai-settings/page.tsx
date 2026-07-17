/**
 * /dashboard/admin/ai-settings
 *
 * Platform-wide AI provider settings (migration 060). Replaces per-user
 * BYOK: the admin connects one key per provider and picks which provider is
 * active. Every user's analyses, cover letters, company research, and
 * voice/story extraction use whatever is active here — switching it takes
 * effect on the very next request, for every user.
 */
import { requireAdmin }       from "@/lib/admin/guard";
import { PlatformAiSettings } from "@/features/admin/PlatformAiSettings";
import { PROVIDER_ORDER, DEFAULT_MODELS } from "@/lib/ai/models";

export const metadata  = { title: "AI provider — Admin — JobTrackr" };
export const dynamic   = "force-dynamic";

export default async function AdminAiSettingsPage() {
  const { admin } = await requireAdmin();

  const { data } = await admin
    .from("platform_ai_settings")
    .select("provider, model, is_active, status, status_reason, last_validated_at");

  const providers = PROVIDER_ORDER.map((provider) => {
    const row = (data ?? []).find((r) => r.provider === provider);
    return {
      provider,
      hasKey:          !!row,
      model:           (row?.model as string | null) ?? DEFAULT_MODELS[provider],
      isActive:        (row?.is_active as boolean | undefined) ?? false,
      statusReason:    (row?.status_reason as string | null) ?? null,
      lastValidatedAt: (row?.last_validated_at as string | null) ?? null,
    };
  });

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">AI provider</h1>
          <p className="page-subtitle">
            One provider serves every user. Connect a key, pick a model, then mark it active —
            the change applies to all analyses, cover letters and research on the next request.
          </p>
        </div>
        <PlatformAiSettings initialProviders={providers} />
      </div>
    </div>
  );
}
