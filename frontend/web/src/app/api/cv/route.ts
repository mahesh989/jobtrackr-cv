/**
 * /api/cv
 *
 * Direct-upload flow (Vercel never sees the file bytes):
 *   1. Browser uploads PDF/DOCX directly to Supabase Storage at
 *      cvs/{user_id}/{cv_id}.{ext} using its user-context Supabase client.
 *      RLS policy (migration 013) requires auth.uid() == first path segment.
 *   2. Browser POSTs JSON {cv_id, label, storage_path, mime_type} here.
 *   3. We call cv-backend /internal/extract-cv-text to get the plain text,
 *      then INSERT a cv_versions row with all fields populated.
 *
 * This means JSON bodies are kilobytes regardless of file size, so we sidestep
 * Vercel's serverless function body limit entirely.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import { extractCvText, extractStories, CvBackendError, type StructuredCv, type CategoriseCvResponse, type Story } from "@/lib/cv/backend";
import { runStructurizeAndCategorise } from "@/lib/cv/structurizeAndCategorise";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime = "nodejs";
// Extract (<=15s) + structurize/categorise in parallel (<=30s) + render
// (<=10s) can legitimately reach ~55s. 60 is the safe ceiling on any Vercel
// plan tier (Hobby included) without needing Fluid compute.
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_EXT = new Set(["pdf", "docx"]);

// ── GET — list ───────────────────────────────────────────────────────────────

export const GET = withUser(async (_req, _ctx, { user }) => {

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cv_versions")
    .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ cvs: data ?? [] });
});

// ── POST — finalise a direct-upload ──────────────────────────────────────────

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {

  // Rate limit: upload triggers 2 AI calls (structurize + categorise).
  const rl = await rateLimit(`cv-upload:${user.id}`, 5, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  let body: { cv_id?: string; label?: string; storage_path?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const cv_id        = (body.cv_id ?? "").trim();
  const label        = (body.label ?? "").trim();
  const storagePath  = (body.storage_path ?? "").trim();

  if (!UUID_RE.test(cv_id)) {
    return jsonError("Invalid cv_id (must be a UUID)", 400);
  }
  if (!label) {
    return jsonError("Missing label", 400);
  }
  // Path must be exactly `${user.id}/${cv_id}.{pdf|docx}` — otherwise the
  // caller is trying to claim someone else's upload or a malformed path.
  const expectedPrefix = `${user.id}/${cv_id}.`;
  if (!storagePath.startsWith(expectedPrefix)) {
    return NextResponse.json(
      { error: "storage_path does not match the authenticated user and cv_id" },
      { status: 400 },
    );
  }
  const ext = storagePath.slice(expectedPrefix.length).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return jsonError(`Unsupported extension .${ext}`, 415);
  }

  const admin = createAdminClient();

  // Reject duplicate POSTs for the same cv_id (e.g. user double-clicks Upload).
  const { data: dup } = await admin
    .from("cv_versions").select("id").eq("id", cv_id).maybeSingle();
  if (dup) {
    return jsonError("This CV is already saved", 409);
  }

  // ── 1. Verify the Storage object actually exists at the claimed path.
  //      Avoid the race where a malicious client POSTs without uploading.
  const { data: head } = await admin
    .storage.from("cvs")
    .list(`${user.id}`, { limit: 1000, search: `${cv_id}.` });
  const exists = (head ?? []).some((o) => o.name === `${cv_id}.${ext}`);
  if (!exists) {
    return NextResponse.json(
      { error: "No file at storage_path. Upload to Storage first, then call this endpoint." },
      { status: 404 },
    );
  }

  // ── 2. Extract text via cv-backend.
  let cvText = "";
  try {
    const result = await extractCvText(storagePath);
    cvText = result.cv_text;
  } catch (err) {
    console.error("[/api/cv POST] extract failed:", err);
    await admin.storage.from("cvs").remove([storagePath]);
    const message = err instanceof CvBackendError
      ? `CV text extraction failed (${err.status})`
      : "CV text extraction unavailable — try again";
    return jsonError(message, 502);
  }

  if (!cvText.trim()) {
    await admin.storage.from("cvs").remove([storagePath]);
    return NextResponse.json(
      { error: "Could not extract any text from this file. Is it a scanned image PDF?" },
      { status: 422 },
    );
  }

  // ── 3. Decide is_active — first upload becomes active automatically.
  const { count: activeCount } = await admin
    .from("cv_versions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("is_active", true);
  const shouldActivate = (activeCount ?? 0) === 0;

  // ── 4. Structurize + categorise in TWO AI calls. Skills are extracted by a
  //      DEDICATED categoriser (explicit caps + breadth incentives) — folding
  //      it into the structurize prompt produced thinner skill lists. We then
  //      merge the categoriser's skills back into structured_cv before persist
  //      and re-render canonical text so normalized_cv_text reflects the full
  //      skill set. Non-fatal — failure leaves structured_cv NULL and the
  //      analysis pipeline falls back to raw cv_text.
  let structuredCv: StructuredCv | null = null;
  let normalizedCvText: string | null = null;
  let categorised: CategoriseCvResponse | null = null;
  const creds = await getActiveAiCredentials();

  if (creds) {
    try {
      const r = await runStructurizeAndCategorise(cvText, creds.provider, creds.apiKey, creds.model);
      structuredCv     = r.structured_cv;
      normalizedCvText = r.normalized_cv_text;
      categorised      = r.categorised;
    } catch (err) {
      console.warn("[/api/cv POST] structurization failed (non-fatal):", err);
    }
  }

  // ── 5. INSERT the row. structured_cv columns are migrated separately
  //      (058 + 059) — if they don't exist yet, fall back to the legacy
  //      insert shape so the upload still succeeds on pre-migration deploys.
  const baseRow = {
    id:                 cv_id,
    user_id:            user.id,
    label,
    pdf_storage_path:   storagePath,
    cv_text:            cvText,
    is_active:          shouldActivate,
    categorised_skills: categorised,
  };
  const withStructured = {
    ...baseRow,
    structured_cv:        structuredCv,
    structured_cv_status: structuredCv ? "parsed" : null,
    normalized_cv_text:   normalizedCvText,
  };

  let row: { id: string; label: string; pdf_storage_path: string; is_active: boolean; categorised_skills: unknown; structured_cv_status?: string | null } | null = null;
  let insertErr: { message: string } | null = null;
  {
    const first = await admin
      .from("cv_versions")
      .insert(withStructured)
      .select("id, label, pdf_storage_path, is_active, categorised_skills, structured_cv_status")
      .single();
    if (first.error && /structured_cv|normalized_cv_text|column/i.test(first.error.message)) {
      console.warn("[/api/cv POST] structured_cv columns missing — falling back to legacy insert (apply migrations 058+059):", first.error.message);
      const fallback = await admin
        .from("cv_versions")
        .insert(baseRow)
        .select("id, label, pdf_storage_path, is_active, categorised_skills")
        .single();
      row = fallback.data as typeof row;
      insertErr = fallback.error ? { message: fallback.error.message } : null;
    } else {
      row = first.data as typeof row;
      insertErr = first.error ? { message: first.error.message } : null;
    }
  }

  if (insertErr || !row) {
    console.error("[/api/cv POST] insert failed:", insertErr?.message);
    await admin.storage.from("cvs").remove([storagePath]);
    return NextResponse.json(
      { error: "Failed to save CV record" },
      { status: 500 },
    );
  }

  // ── 6. Fire-and-forget story extraction — populates the stories tab automatically.
  //      Non-fatal: if it fails the user can click "Re-extract from CV" on the
  //      stories page.
  if (creds && cvText.trim()) {
    void (async () => {
      try {
        const result = await extractStories({
          user_id:     user.id,
          cv_text:     cvText,
          ai_provider: creds.provider,
          ai_api_key:  creds.apiKey,
          ai_model:    creds.model ?? null,
        });
        if (result.stories.length > 0) {
          const rows = result.stories.map((s) => {
            const { id: _id, ...rest } = s as Story & { id?: unknown };
            void _id;
            return rest;
          });
          await admin.rpc("replace_stories", { p_user_id: user.id, p_rows: rows });
        }
      } catch (err) {
        console.warn("[/api/cv POST] auto story extraction failed (non-fatal):", (err as Error).message);
      }
    })();
  }

  // Forced redirect: a freshly-parsed CV must be reviewed before it's used.
  // When structurization failed (no key, AI error), skip the review and behave
  // like the legacy flow — analysis still works against the raw cv_text.
  const redirect_to = structuredCv ? `/cv/${cv_id}/review` : null;

  const responseRow = row as Record<string, unknown>;
  return NextResponse.json({
    ...responseRow,
    word_count:         cvText.split(/\s+/).length,
    has_categorisation: categorised !== null,
    redirect_to,
  });
});
