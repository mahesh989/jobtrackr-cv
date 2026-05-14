import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { AiKeyCard, type AiKeyProvider, type AiKeyState } from "@/components/cv/AiKeyCard";

export const metadata = { title: "AI keys — JobTrackr" };

const PROVIDERS: AiKeyProvider[] = ["anthropic", "openai", "deepseek"];

export default async function AiKeysPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("user_integrations")
    .select("provider, status, status_reason, last_validated_at, is_enabled")
    .eq("user_id", user.id)
    .in("provider", PROVIDERS);

  interface IntegrationRow {
    provider:          AiKeyProvider;
    status:            string;
    status_reason:     string | null;
    last_validated_at: string | null;
    is_enabled:        boolean;
  }

  const byProvider = new Map<AiKeyProvider, AiKeyState>();
  for (const r of (rows ?? []) as IntegrationRow[]) {
    byProvider.set(r.provider, {
      connected:         true,
      status:            r.status,
      status_reason:     r.status_reason,
      last_validated_at: r.last_validated_at,
      is_enabled:        r.is_enabled,
    });
  }

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">AI keys</h1>
        <p className="text-[12px] text-text-3 mt-0.5">
          Bring your own API key from at least one provider. The analyser uses
          whichever key you have configured — if you have more than one, Anthropic
          is preferred, then OpenAI, then DeepSeek.
        </p>
      </div>

      <div className="px-6 py-6 max-w-3xl space-y-4">
        {PROVIDERS.map((p) => (
          <AiKeyCard
            key={p}
            provider={p}
            initial={byProvider.get(p) ?? { connected: false }}
          />
        ))}
      </div>
    </div>
  );
}
