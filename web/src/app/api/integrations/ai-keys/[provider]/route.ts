/**
 * /api/integrations/ai-keys/[provider]
 *
 * BYOK API key management for Anthropic / OpenAI / DeepSeek. Mirrors the
 * /api/integrations/apify pattern: store encrypted via AES-256-GCM, never
 * return raw key to the browser, validate with the provider's API before
 * accepting.
 *
 * provider ∈ {anthropic, openai, deepseek}
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { encryptApiKey }             from "@/lib/integrations/crypto";

type Provider = "anthropic" | "openai" | "deepseek";

const PROVIDERS = new Set<Provider>(["anthropic", "openai", "deepseek"]);

interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ── Per-provider validation by hitting the provider's models endpoint ────────

async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key":          key,
        "anthropic-version":  "2023-06-01",
      },
      signal: AbortSignal.timeout(8_000),
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

async function validateKey(provider: Provider, key: string): Promise<ValidationResult> {
  switch (provider) {
    case "anthropic": return validateAnthropicKey(key);
    case "openai":    return validateOpenAIKey(key);
    case "deepseek":  return validateDeepSeekKey(key);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseProvider(p: string): Provider | null {
  return PROVIDERS.has(p as Provider) ? (p as Provider) : null;
}

async function authedUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ── GET — status only, never the key ─────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { provider: raw } = await params;
  const provider = parseProvider(raw);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_integrations")
    .select("status, status_reason, last_validated_at, is_enabled")
    .eq("user_id", user.id)
    .eq("provider", provider)
    .maybeSingle();

  if (!data) return NextResponse.json({ connected: false });
  return NextResponse.json({ connected: true, ...data });
}

// ── POST — validate + encrypt + upsert ───────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { provider: raw } = await params;
  const provider = parseProvider(raw);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });

  let key: string;
  try {
    const body = await req.json();
    key = (body.key ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!key) return NextResponse.json({ error: "Key is required" }, { status: 400 });

  const { valid, error: validationError } = await validateKey(provider, key);
  if (!valid) {
    return NextResponse.json({ valid: false, error: validationError }, { status: 422 });
  }

  const encrypted = encryptApiKey(key);
  const admin = createAdminClient();

  const { error: dbError } = await admin
    .from("user_integrations")
    .upsert(
      {
        user_id:           user.id,
        provider,
        encrypted_api_key: encrypted,
        status:            "valid",
        status_reason:     null,
        last_validated_at: new Date().toISOString(),
        is_enabled:        true,
        updated_at:        new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    );

  if (dbError) {
    console.error(`[/api/integrations/ai-keys/${provider} POST] db error:`, dbError.message);
    return NextResponse.json({ error: "Failed to save key" }, { status: 500 });
  }

  return NextResponse.json({ valid: true });
}

// ── DELETE — disconnect ──────────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { provider: raw } = await params;
  const provider = parseProvider(raw);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_integrations")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", provider);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ disconnected: true });
}
