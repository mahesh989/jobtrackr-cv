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
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { extractCvText, CvBackendError } from "@/lib/cvBackend";

export const runtime = "nodejs";
// Extraction is normally <3s; allow headroom for cold-edge cases.
export const maxDuration = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_EXT = new Set(["pdf", "docx"]);

// ── GET — list ───────────────────────────────────────────────────────────────

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cv_versions")
    .select("id, label, pdf_storage_path, is_active, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cvs: data ?? [] });
}

// ── POST — finalise a direct-upload ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { cv_id?: string; label?: string; storage_path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cv_id        = (body.cv_id ?? "").trim();
  const label        = (body.label ?? "").trim();
  const storagePath  = (body.storage_path ?? "").trim();

  if (!UUID_RE.test(cv_id)) {
    return NextResponse.json({ error: "Invalid cv_id (must be a UUID)" }, { status: 400 });
  }
  if (!label) {
    return NextResponse.json({ error: "Missing label" }, { status: 400 });
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
    return NextResponse.json({ error: `Unsupported extension .${ext}` }, { status: 415 });
  }

  const admin = createAdminClient();

  // Reject duplicate POSTs for the same cv_id (e.g. user double-clicks Upload).
  const { data: dup } = await admin
    .from("cv_versions").select("id").eq("id", cv_id).maybeSingle();
  if (dup) {
    return NextResponse.json({ error: "This CV is already saved" }, { status: 409 });
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
    return NextResponse.json({ error: message }, { status: 502 });
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

  // ── 4. INSERT the row.
  const { data: row, error: insertErr } = await admin
    .from("cv_versions")
    .insert({
      id:               cv_id,
      user_id:          user.id,
      label,
      pdf_storage_path: storagePath,
      cv_text:          cvText,
      is_active:        shouldActivate,
    })
    .select("id, label, pdf_storage_path, is_active")
    .single();

  if (insertErr || !row) {
    console.error("[/api/cv POST] insert failed:", insertErr?.message);
    await admin.storage.from("cvs").remove([storagePath]);
    return NextResponse.json(
      { error: "Failed to save CV record" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ...row, word_count: cvText.split(/\s+/).length });
}
