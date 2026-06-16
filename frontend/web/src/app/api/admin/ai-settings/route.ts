/**
 * /api/admin/ai-settings
 *
 * Founder/admin-only management of the single platform-wide AI provider.
 * Replaces per-user BYOK (migration 060) — every user's analysis, cover
 * letter, company research, voice/story extraction etc. uses whichever
 * provider row has is_active=true here.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { encryptApiKey }             from "@/lib/integrations/crypto";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { PROVIDER_ORDER, DEFAULT_MODELS, type AiProvider } from "@/lib/ai/models";

const PROVIDERS = new Set<AiProvider>(PROVIDER_ORDER);

async function requireAdminUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data: me } = await admin.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) return null;
  return { userId: user.id, admin };
}

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

export async function GET() {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await ctx.admin
    .from("platform_ai_settings")
    .select("provider, model, is_active, status, status_reason, last_validated_at, updated_at")
    .order("provider");

  if (error) return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });

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
}

// ── PATCH — set key / model / active provider for a single provider ─────────
// body: { provider, key?: string, model?: string, setActive?: boolean }

export async function PATCH(req: NextRequest) {
  const ctx = await requireAdminUser();
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { provider?: string; key?: string; model?: string; setActive?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = body.provider;
  if (!provider || !PROVIDERS.has(provider as AiProvider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  const p = provider as AiProvider;

  const rl = await rateLimit(`admin-ai-settings:${ctx.userId}`, 20, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: ctx.userId };

  if (typeof body.key === "string" && body.key.trim()) {
    const key = body.key.trim();
    const { valid, error } = await validateKey(p, key);
    if (!valid) return NextResponse.json({ valid: false, error }, { status: 422 });
    update.encrypted_api_key  = encryptApiKey(key);
    update.status             = "valid";
    update.status_reason      = null;
    update.last_validated_at  = new Date().toISOString();
  }

  if (typeof body.model === "string" && body.model.trim()) {
    update.model = body.model.trim();
  }

  const { error: upsertErr } = await ctx.admin
    .from("platform_ai_settings")
    .upsert({ provider: p, ...update }, { onConflict: "provider" });
  if (upsertErr) {
    console.error("[/api/admin/ai-settings PATCH] upsert failed:", upsertErr.message);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }

  if (body.setActive === true) {
    // Require the provider to actually have a valid key before activating it.
    const { data: row } = await ctx.admin
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
    await ctx.admin.from("platform_ai_settings").update({ is_active: false }).neq("provider", p);
    const { error: activateErr } = await ctx.admin
      .from("platform_ai_settings")
      .update({ is_active: true, updated_at: new Date().toISOString(), updated_by: ctx.userId })
      .eq("provider", p);
    if (activateErr) {
      console.error("[/api/admin/ai-settings PATCH] activate failed:", activateErr.message);
      return NextResponse.json({ error: "Failed to activate provider" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
