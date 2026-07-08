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
import { getActiveAiCredentials }                        from "@/lib/ai/activeProvider";
import { extractStories, Story, CvBackendError }         from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 90;   // AI call on dense CVs; mirrors cv-backend 90s timeout

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

  // ── 3. Resolve platform AI provider/key/model ────────────────────────────────
  const creds = await getActiveAiCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "No AI provider configured. Contact your administrator." },
      { status: 422 },
    );
  }
  const chosen   = creds.provider;
  const aiApiKey = creds.apiKey;

  // ── 4. Call cv-backend ───────────────────────────────────────────────────────
  // cv.cv_text is intentionally not logged below — privacy boundary.
  let result: { stories: Story[]; diagnostic: string | null };
  try {
    result = await extractStories({
      user_id:     user.id,
      cv_text:     cv.cv_text,   // PRIVACY: never log this variable
      ai_provider: chosen,
      ai_api_key:  aiApiKey,
      ai_model:    creds.model ?? null,
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

  // ── 6. Atomic overwrite via replace_stories RPC (migration 023) ──────────────
  // DELETE + INSERT are wrapped in a single plpgsql transaction, eliminating
  // the DELETE-INSERT gap that existed in Phase 10.2.a. If the INSERT fails,
  // the DELETE is rolled back and the user's previous batch is preserved.
  //
  // id is omitted from each row — the DB generates it via gen_random_uuid().
  // extraction_timestamp is already set by cv-backend (ISO 8601 string from
  // FastAPI datetime serialisation) — all rows in the batch share the same value.
  const rows = result.stories.map((s) => {
    // Strip `id` if the Story schema ever includes it (always null from extraction,
    // but defensive: we must not pass null into the RPC's id-less INSERT).
    const { id: _id, ...rest } = s as Story & { id?: unknown };
    void _id;
    return rest;
  });

  const { error: rpcErr } = await admin.rpc("replace_stories", {
    p_user_id: user.id,
    p_rows:    rows,
  });

  if (rpcErr) {
    console.error("[/api/user/stories/extract] replace_stories RPC failed:", rpcErr.message);
    return NextResponse.json(
      { error: "Stories extracted but could not be saved. Please try again." },
      { status: 500 },
    );
  }

  // ── 7. Fetch the saved stories from the DB to get their generated IDs ────────
  const { data: savedStories, error: fetchErr } = await admin
    .from("stories")
    .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
    .eq("user_id", user.id)
    .eq("extraction_timestamp", result.stories[0].extraction_timestamp)
    .order("created_at", { ascending: true });

  if (fetchErr) {
    console.error("[/api/user/stories/extract] fetch saved stories failed:", fetchErr.message);
    // Fallback to returning raw stories if fetching fails (better than crashing)
    return NextResponse.json({
      stories:    result.stories,
      count:      result.stories.length,
      diagnostic: null,
    });
  }

  return NextResponse.json({
    stories:    savedStories ?? [],
    count:      (savedStories ?? []).length,
    diagnostic: null,
  });
}
