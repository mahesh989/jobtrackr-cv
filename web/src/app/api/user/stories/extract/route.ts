/**
 * POST /api/user/stories/extract
 *
 * Extract structured achievement stories from the current user's active master
 * CV. Uses the user's BYOK AI provider (same key-resolution pattern as
 * /api/user/voice-profile). Stores results in the `stories` table via an
 * atomic delete-then-insert, replacing the prior extraction batch entirely.
 *
 * No request body needed — the CV is read server-side from cv_versions.
 *
 * Responses:
 *   200  { stories, count, diagnostic }  — extraction complete (stories may be empty)
 *   401  Unauthorized
 *   422  No active CV / no AI key / CV too short
 *   500  DB or decryption failure
 *   502  cv-backend AI call failed
 *
 * PRIVACY: cv.cv_text is sensitive — it must never appear in console.log,
 * console.error, or any other log call in this file. Log only metadata:
 * error messages, status codes, and story counts.
 */

import { NextResponse }                                  from "next/server";
import { createClient }                                  from "@/lib/supabase/server";
import { createAdminClient }                             from "@/lib/supabase/admin";
import { decryptApiKey }                                 from "@/lib/integrations/crypto";
import { extractStories, Story, CvBackendError }         from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 90;   // AI call on dense CVs; mirrors cv-backend 90s timeout

const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type  Provider          = (typeof PROVIDER_PRIORITY)[number];

export async function POST() {
  // ── 1. Verify session ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // ── 2. Fetch active CV ───────────────────────────────────────────────────────
  // Select cv_text only — it is passed to cv-backend and never returned to the
  // browser. The `id` is fetched for logging purposes only (not the text).
  const { data: cv, error: cvErr } = await admin
    .from("cv_versions")
    .select("id, cv_text")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (cvErr) {
    console.error("[/api/user/stories/extract] cv fetch error:", cvErr.message);
    return NextResponse.json({ error: "Failed to fetch active CV." }, { status: 500 });
  }

  if (!cv?.cv_text?.trim()) {
    return NextResponse.json(
      { error: "No active CV found — upload and set a CV as active first." },
      { status: 422 },
    );
  }

  // ── 3. Resolve AI key (identical to voice-profile/route.ts) ─────────────────
  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, status, config")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);

  const keyByProvider = new Map<Provider, { encrypted: string; model: string | null }>();
  for (const row of (keys ?? []) as Array<{
    provider:          Provider;
    encrypted_api_key: string;
    config:            { model?: string } | null;
  }>) {
    keyByProvider.set(row.provider, {
      encrypted: row.encrypted_api_key,
      model:     row.config?.model ?? null,
    });
  }

  const chosen = PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));
  if (!chosen) {
    return NextResponse.json(
      { error: "No AI key configured. Add one in Settings → Integrations." },
      { status: 422 },
    );
  }

  const entry = keyByProvider.get(chosen)!;
  let aiApiKey: string;
  try {
    aiApiKey = decryptApiKey(entry.encrypted);
  } catch (err) {
    console.error("[/api/user/stories/extract] decrypt failed:", (err as Error).message);
    return NextResponse.json(
      { error: "Could not decrypt your AI key. Re-connect it in Settings → Integrations." },
      { status: 500 },
    );
  }

  // ── 4. Call cv-backend ───────────────────────────────────────────────────────
  // cv.cv_text is intentionally not logged below — privacy boundary.
  let result: { stories: Story[]; diagnostic: string | null };
  try {
    result = await extractStories({
      user_id:     user.id,
      cv_text:     cv.cv_text,   // PRIVACY: never log this variable
      ai_provider: chosen,
      ai_api_key:  aiApiKey,
      ai_model:    entry.model ?? null,
    });
  } catch (err) {
    if (err instanceof CvBackendError && err.status === 422) {
      return NextResponse.json(
        { error: "CV is too short or empty to extract stories." },
        { status: 422 },
      );
    }
    console.error(
      "[/api/user/stories/extract] cv-backend error:",
      err instanceof CvBackendError ? err.status : (err as Error).message,
    );
    return NextResponse.json(
      { error: "Story extraction failed. Please try again." },
      { status: 502 },
    );
  }

  // ── 5. Empty extraction ──────────────────────────────────────────────────────
  // HTTP 200 with empty array + diagnostic. No DB write needed — nothing to store.
  // The caller should surface the diagnostic message to guide the user.
  if (result.stories.length === 0) {
    return NextResponse.json(
      { stories: [], count: 0, diagnostic: result.diagnostic },
      { status: 200 },
    );
  }

  // ── 6. Atomic overwrite: delete prior batch, insert new batch ────────────────
  // These are two separate Supabase calls — not a true DB transaction.
  //
  // INSERT atomicity: admin.from("stories").insert(rows) sends the full array
  // as a single SQL INSERT ... VALUES (...) statement. A partial write — some
  // stories saved, some not — cannot occur; Postgres accepts or rejects the
  // whole statement as one unit.
  //
  // DELETE-INSERT gap: if DELETE succeeds but INSERT fails, the user temporarily
  // has 0 stories. Re-running extraction is the safe recovery path.
  //
  // TODO Phase 10.2.b: wrap both calls in a Supabase RPC function using a DB
  // transaction to eliminate the DELETE-INSERT gap. Deferred here because in
  // Phase 10.2.a stories are only written, not yet read by the matching layer,
  // so the cost of a transient 0-story state is low.
  const { error: deleteErr } = await admin
    .from("stories")
    .delete()
    .eq("user_id", user.id);

  if (deleteErr) {
    console.error("[/api/user/stories/extract] delete failed:", deleteErr.message);
    return NextResponse.json(
      { error: "Failed to clear existing stories." },
      { status: 500 },
    );
  }

  // Stamp user_id onto each story row before inserting. extraction_timestamp
  // is already set by cv-backend (ISO 8601 string from FastAPI datetime
  // serialisation) — all rows in the batch share the same value.
  const rows = result.stories.map((s) => ({ ...s, user_id: user.id }));

  const { error: insertErr } = await admin.from("stories").insert(rows);

  if (insertErr) {
    console.error("[/api/user/stories/extract] insert failed:", insertErr.message);
    return NextResponse.json(
      { error: "Stories extracted but could not be saved. Please try again." },
      { status: 500 },
    );
  }

  // ── 7. Return ────────────────────────────────────────────────────────────────
  return NextResponse.json({
    stories:    result.stories,
    count:      result.stories.length,
    diagnostic: null,
  });
}
