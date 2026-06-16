/**
 * Resolves the platform-wide AI provider/key/model configured by an admin in
 * Settings → Admin → AI provider (platform_ai_settings, migration 060).
 *
 * BYOK is gone — there is exactly one active provider at a time (enforced by
 * a partial unique index), and every user's analyses, cover letters, company
 * research, voice/story extraction etc. use it. When the admin flips the
 * active provider, the next request from ANY user picks it up immediately —
 * nothing is cached.
 */

import { createAdminClient }            from "@/lib/supabase/admin";
import { decryptApiKey }                from "@/lib/integrations/crypto";
import { DEFAULT_MODELS, type AiProvider } from "@/lib/ai/models";

export type { AiProvider };

export interface ActiveAiCredentials {
  provider: AiProvider;
  apiKey:   string;
  model:    string;
}

export async function getActiveAiCredentials(): Promise<ActiveAiCredentials | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("platform_ai_settings")
    .select("provider, encrypted_api_key, model, status")
    .eq("is_active", true)
    .maybeSingle();

  if (!data?.encrypted_api_key || data.status !== "valid") return null;

  const provider = data.provider as AiProvider;
  try {
    const apiKey = decryptApiKey(data.encrypted_api_key as string);
    return { provider, apiKey, model: (data.model as string) || DEFAULT_MODELS[provider] };
  } catch {
    return null;
  }
}
