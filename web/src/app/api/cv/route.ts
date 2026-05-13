/**
 * /api/cv
 *
 * POST  — accepts a PDF or DOCX upload, stores it in Supabase Storage,
 *         calls cv-backend to extract plain text, then INSERTs a
 *         cv_versions row owned by the current user. If the user has no
 *         active CV yet, the new one is marked is_active=true.
 *
 * GET   — list the current user's CV versions (no file bytes, just metadata).
 *
 * The PDF/DOCX bytes never live in the JS process longer than necessary —
 * we stream them through to Storage and discard.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { extractCvText, CvBackendError } from "@/lib/cvBackend";

// Vercel Hobby tier hard-caps function bodies at 4.5 MB and there is no way
// to raise that via Next.js App Router. So our cap is 4 MB to stay safely
// inside. The browser pre-checks; the server enforces.
export const runtime = "nodejs";

// Default Hobby plan timeout is 10s. With one cv-backend machine kept warm,
// extraction usually completes in <3s; 25s gives generous headroom.
export const maxDuration = 25;

const MAX_BYTES = 4 * 1024 * 1024;       // 4 MB (Vercel Hobby body limit is 4.5 MB)
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

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

// ── POST — upload + extract + insert ─────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file  = form.get("file");
  const label = (form.get("label") ?? "").toString().trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "unknown"}. Upload a PDF or DOCX.` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Cap is 4 MB.` },
      { status: 413 },
    );
  }
  if (!label) {
    return NextResponse.json({ error: "Missing 'label' field" }, { status: 400 });
  }

  const admin = createAdminClient();

  // ── 1. Insert a draft row so we have an id for the storage path
  const { data: draft, error: insertErr } = await admin
    .from("cv_versions")
    .insert({
      user_id:          user.id,
      label,
      pdf_storage_path: "pending",   // overwritten below
      cv_text:          "",          // populated after extraction
      is_active:        false,       // promoted to true at the end if it's their first
    })
    .select("id")
    .single();

  if (insertErr || !draft) {
    console.error("[/api/cv POST] insert draft failed:", insertErr?.message);
    return NextResponse.json({ error: "Failed to create CV record" }, { status: 500 });
  }

  const ext         = MIME_EXT[file.type];
  const storagePath = `${user.id}/${draft.id}.${ext}`;

  // ── 2. Upload to Storage
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await admin
    .storage
    .from("cvs")
    .upload(storagePath, buffer, { contentType: file.type, upsert: false });

  if (uploadErr) {
    console.error("[/api/cv POST] storage upload failed:", uploadErr.message);
    await admin.from("cv_versions").delete().eq("id", draft.id);
    return NextResponse.json({ error: `Storage upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  // ── 3. Ask cv-backend to extract text
  let cvText = "";
  try {
    const result = await extractCvText(storagePath);
    cvText = result.cv_text;
  } catch (err) {
    console.error("[/api/cv POST] extract failed:", err);
    // Clean up — Storage object + DB row — so the user can retry.
    await admin.storage.from("cvs").remove([storagePath]);
    await admin.from("cv_versions").delete().eq("id", draft.id);
    const message = err instanceof CvBackendError
      ? `CV text extraction failed (${err.status})`
      : "CV text extraction unavailable — try again";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!cvText.trim()) {
    await admin.storage.from("cvs").remove([storagePath]);
    await admin.from("cv_versions").delete().eq("id", draft.id);
    return NextResponse.json(
      { error: "Could not extract any text from this file. Is it a scanned image PDF?" },
      { status: 422 },
    );
  }

  // ── 4. Decide is_active — first upload by this user becomes active
  const { count: existingCount } = await admin
    .from("cv_versions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("is_active", true);
  const shouldActivate = (existingCount ?? 0) === 0;

  // ── 5. Finalise the row
  const { error: updateErr } = await admin
    .from("cv_versions")
    .update({
      pdf_storage_path: storagePath,
      cv_text:          cvText,
      is_active:        shouldActivate,
    })
    .eq("id", draft.id);

  if (updateErr) {
    console.error("[/api/cv POST] finalise failed:", updateErr.message);
    return NextResponse.json({ error: "Failed to finalise CV record" }, { status: 500 });
  }

  return NextResponse.json({
    id:               draft.id,
    label,
    pdf_storage_path: storagePath,
    is_active:        shouldActivate,
    word_count:       cvText.split(/\s+/).length,
  });
}
