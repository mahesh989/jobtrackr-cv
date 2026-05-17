/**
 * /api/user/voice-profile
 *
 * GET  — return the current user's voice fingerprint (deliberately omits
 *         voice_sample_raw — it must never be returned after initial submission).
 * POST — submit a new writing sample, extract a voice fingerprint via cv-backend
 *         (BYOK), then upsert into voice_profiles.
 *
 * POST body:
 *   { voice_sample_text: string, provider?: string }
 *
 * NOTE: voice_sample_text must never appear in server logs here or downstream.
 */

import { NextRequest, NextResponse }                          from "next/server";
import { createClient }                                        from "@/lib/supabase/server";
import { createAdminClient }                                   from "@/lib/supabase/admin";
import { decryptApiKey }                                       from "@/lib/integrations/crypto";
import { extractVoiceFingerprint, CvBackendError }             from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 60;

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  // Deliberately exclude voice_sample_raw — it must never be returned after submission.
  const { data } = await admin
    .from("voice_profiles")
    .select("id, fingerprint, voice_sample_trust_score, voice_sample_source, created_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({ profile: data ?? null });
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { voice_sample_text?: unknown; provider?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const voiceSample = typeof body.voice_sample_text === "string" ? body.voice_sample_text.trim() : "";
  if (!voiceSample) {
    return NextResponse.json({ error: "voice_sample_text is required" }, { status: 422 });
  }

  // ── Resolve AI key (same pattern as /api/jobs/[id]/analyze) ──────────────
  const admin = createAdminClient();
  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, status, config")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);

  const keyByProvider = new Map<Provider, { encrypted: string; model: string | null }>();
  for (const row of (keys ?? []) as Array<{
    provider: Provider; encrypted_api_key: string; config: { model?: string } | null;
  }>) {
    keyByProvider.set(row.provider, { encrypted: row.encrypted_api_key, model: row.config?.model ?? null });
  }

  const rawProvider = typeof body.provider === "string" ? body.provider : null;
  const preferred   = rawProvider && PROVIDER_PRIORITY.includes(rawProvider as Provider)
    ? rawProvider as Provider : null;
  const chosen      = (preferred && keyByProvider.has(preferred))
    ? preferred
    : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key configured. Add one in Settings → AI keys." },
      { status: 422 },
    );
  }

  const entry = keyByProvider.get(chosen)!;
  let aiApiKey: string;
  try {
    aiApiKey = decryptApiKey(entry.encrypted);
  } catch (err) {
    console.error("[/api/user/voice-profile] decrypt failed:", err);
    return NextResponse.json(
      { error: "Could not decrypt your AI key. Re-connect it in Settings → AI keys." },
      { status: 500 },
    );
  }

  // ── Call cv-backend to extract fingerprint ────────────────────────────────
  let result: Awaited<ReturnType<typeof extractVoiceFingerprint>>;
  try {
    result = await extractVoiceFingerprint({
      voice_sample_text: voiceSample,
      ai_provider:       chosen,
      ai_api_key:        aiApiKey,
      ai_model:          entry.model ?? null,
    });
  } catch (err) {
    if (err instanceof CvBackendError && err.status === 422) {
      return NextResponse.json({ error: "Voice sample is too short or empty." }, { status: 422 });
    }
    console.error(
      "[/api/user/voice-profile] cv-backend error:",
      err instanceof CvBackendError ? err.status : err,
    );
    return NextResponse.json(
      { error: "Voice fingerprint extraction failed. Try again." },
      { status: 502 },
    );
  }

  // ── Upsert into voice_profiles ────────────────────────────────────────────
  // TODO Phase 1.5: warn user if new submission has materially worse trust_score
  // than existing row. Currently silent overwrite.
  const { error: upsertErr } = await admin
    .from("voice_profiles")
    .upsert(
      {
        user_id:                  user.id,
        voice_sample_raw:         voiceSample,
        voice_sample_source:      "in_app_capture",
        voice_sample_trust_score: result.trust_score,
        fingerprint:              result.fingerprint,
        updated_at:               new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (upsertErr) {
    console.error("[/api/user/voice-profile] upsert failed:", upsertErr.message);
    return NextResponse.json({ error: "Failed to save voice profile" }, { status: 500 });
  }

  return NextResponse.json({
    trust_score:        result.trust_score,
    trust_components:   result.trust_components,
    word_count:         result.word_count,
    matched_ai_phrases: result.matched_ai_phrases,
    fingerprint:        result.fingerprint,
  });
}
