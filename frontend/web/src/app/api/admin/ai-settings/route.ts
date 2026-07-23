/**
 * /api/admin/ai-settings
 *
 * Founder/admin-only management of the single platform-wide AI provider.
 * Replaces per-user BYOK (migration 060) — every user's analysis, cover
 * letter, company research, voice/story extraction etc. uses whichever
 * provider row has is_active=true here.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, withAdmin, parseJsonBody } from "@/lib/api-utils";
import { encryptApiKey }             from "@/lib/integrations/crypto";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { PROVIDER_ORDER, DEFAULT_MODELS, type AiProvider } from "@/lib/ai/models";

const PROVIDERS = new Set<AiProvider>(PROVIDER_ORDER);

interface ValidationResult { valid: boolean; error?: string }

async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.ok)              return { valid: true };
    if (res.status === 401)  return { valid: false, error: "Invalid Anthropic API key" };
    return { valid: false, error: `Anthropic returned ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Could not reach Anthropic: ${err instanceof Error ? err.message : "network error"}` };
  }
}

async function validateOpenAIKey(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.ok)              return { valid: true };
    if (res.status === 401)  return { valid: false, error: "Invalid OpenAI API key" };
    return { valid: false, error: `OpenAI returned ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Could not reach OpenAI: ${err instanceof Error ? err.message : "network error"}` };
  }
}

async function validateDeepSeekKey(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.deepseek.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.ok)              return { valid: true };
    if (res.status === 401)  return { valid: false, error: "Invalid DeepSeek API key" };
    return { valid: false, error: `DeepSeek returned ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Could not reach DeepSeek: ${err instanceof Error ? err.message : "network error"}` };
  }
}

async function validateKey(provider: AiProvider, key: string): Promise<ValidationResult> {
  switch (provider) {
    case "anthropic": return validateAnthropicKey(key);
    case "openai":    return validateOpenAIKey(key);
    case "deepseek":  return validateDeepSeekKey(key);
  }
}

// ── GET — list all 3 provider rows (never the decrypted key) ────────────────

export const GET = withAdmin(async (_req: NextRequest, _ctx, { admin }) => {

  const { data, error } = await admin
    .from("platform_ai_settings")
    .select("provider, model, is_active, status, status_reason, last_validated_at, updated_at")
    .order("provider");

  if (error) return jsonError("Failed to load settings", 500);

  const rows = PROVIDER_ORDER.map((provider) => {
    const row = (data ?? []).find((r) => r.provider === provider);
    return {
      provider,
      hasKey:           !!row,
      model:            row?.model ?? DEFAULT_MODELS[provider],
      isActive:         row?.is_active ?? false,
      status:           row?.status ?? null,
      statusReason:     row?.status_reason ?? null,
      lastValidatedAt:  row?.last_validated_at ?? null,
    };
  });

  return NextResponse.json({ providers: rows });
});

// ── PATCH — set key / model / active provider for a single provider ─────────
// body: { provider, key?: string, model?: string, setActive?: boolean }

export const PATCH = withAdmin(async (req: NextRequest, _ctx, { userId, admin }) => {

  const { data: body, error: parseErr } = await parseJsonBody<{
    provider?: string; key?: string; model?: string; setActive?: boolean;
  }>(req);
  if (parseErr) return parseErr;

  const provider = body!.provider;
  if (!provider || !PROVIDERS.has(provider as AiProvider)) {
    return jsonError("Unknown provider", 400);
  }
  const p = provider as AiProvider;

  const rl = await rateLimit(`admin-ai-settings:${userId}`, 20, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId };

  if (typeof body!.key === "string" && body!.key.trim()) {
    const key = body!.key.trim();
    const { valid, error } = await validateKey(p, key);
    if (!valid) return NextResponse.json({ valid: false, error }, { status: 422 });
    update.encrypted_api_key  = encryptApiKey(key);
    update.status             = "valid";
    update.status_reason      = null;
    update.last_validated_at  = new Date().toISOString();
  }

  if (typeof body!.model === "string" && body!.model.trim()) {
    update.model = body!.model.trim();
  }

  const { error: upsertErr } = await admin
    .from("platform_ai_settings")
    .upsert({ provider: p, ...update }, { onConflict: "provider" });
  if (upsertErr) {
    console.error("[/api/admin/ai-settings PATCH] upsert failed:", upsertErr.message);
    return jsonError("Failed to save settings", 500);
  }

  if (body!.setActive === true) {
    // Require the provider to actually have a valid key before activating it.
    const { data: row } = await admin
      .from("platform_ai_settings")
      .select("status, encrypted_api_key")
      .eq("provider", p)
      .maybeSingle();
    if (!row?.encrypted_api_key || row.status !== "valid") {
      return NextResponse.json(
        { error: "Connect and validate a key for this provider before activating it." },
        { status: 422 },
      );
    }
    await admin.from("platform_ai_settings").update({ is_active: false }).neq("provider", p);
    const { error: activateErr } = await admin
      .from("platform_ai_settings")
      .update({ is_active: true, updated_at: new Date().toISOString(), updated_by: userId })
      .eq("provider", p);
    if (activateErr) {
      console.error("[/api/admin/ai-settings PATCH] activate failed:", activateErr.message);
      return jsonError("Failed to activate provider", 500);
    }
  }

  return NextResponse.json({ ok: true });
});
