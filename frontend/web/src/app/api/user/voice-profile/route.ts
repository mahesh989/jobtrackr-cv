/**
 * /api/user/voice-profile
 *
 * GET  — return the current user's voice fingerprint AND the raw sample text
 *         so they can view + edit it. (Earlier versions hid the raw sample
 *         "for safety" but it's the user's own writing — no reason to lock
 *         them out of their own data.)
 * POST — submit a new writing sample, extract a voice fingerprint via cv-backend
 *         (BYOK), then upsert into voice_profiles. Accepts an optional
 *         `source` field so we can record whether the sample was freshly
 *         typed or pasted from an existing cover letter.
 *
 * POST body:
 *   { voice_sample_text: string, source?: string }
 *
 * NOTE: voice_sample_text must never appear in server logs here or downstream.
 */

import { NextRequest, NextResponse }                          from "next/server";
import { createClient }                                        from "@/lib/supabase/server";
import { createAdminClient }                                   from "@/lib/supabase/admin";
import { getActiveAiCredentials }                              from "@/lib/ai/activeProvider";
import { extractVoiceFingerprint, CvBackendError }             from "@/lib/cvBackend";
import type { SourceTag }                                      from "@/features/cv/voice/types";

export const runtime     = "nodejs";
export const maxDuration = 60;

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  // Returns voice_sample_raw too — the user owns this text, they should be
  // able to see what we have stored and edit it.
  const { data } = await admin
    .from("voice_profiles")
    .select("id, fingerprint, voice_sample_raw, voice_sample_trust_score, voice_sample_source, created_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({ profile: data ?? null });
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { voice_sample_text?: unknown; source?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const voiceSample = typeof body.voice_sample_text === "string" ? body.voice_sample_text.trim() : "";
  if (!voiceSample) {
    return NextResponse.json({ error: "voice_sample_text is required" }, { status: 422 });
  }

  // Normalise the source tag. Defaults to in_app_capture so legacy clients
  // that don't send a source keep working unchanged.
  const ALLOWED_SOURCES: readonly SourceTag[] = ["in_app_capture", "pasted_cover_letter"];
  const sourceRaw = typeof body.source === "string" ? body.source : null;
  const source: SourceTag = sourceRaw && (ALLOWED_SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as SourceTag)
    : "in_app_capture";

  // ── Resolve platform AI provider/key/model ────────────────────────────────
  const admin = createAdminClient();
  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const chosen   = creds.provider;
  const aiApiKey = creds.apiKey;

  // ── Call cv-backend to extract fingerprint ────────────────────────────────
  let result: Awaited<ReturnType<typeof extractVoiceFingerprint>>;
  try {
    result = await extractVoiceFingerprint({
      voice_sample_text: voiceSample,
      ai_provider:       chosen,
      ai_api_key:        aiApiKey,
      ai_model:          creds.model ?? null,
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
        voice_sample_source:      source,
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
