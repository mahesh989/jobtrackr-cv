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
import { decryptApiKey }             from "@/lib/integrations/crypto";
import { extractCvText, structurizeCv, CvBackendError, type StructuredCv } from "@/lib/cvBackend";

// Same priority order as /api/jobs/[id]/analyze — Anthropic preferred for quality.
const PROVIDER_PRIORITY = ["anthropic", "openai", "deepseek"] as const;
type Provider = (typeof PROVIDER_PRIORITY)[number];

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
    .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at, updated_at")
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

  let body: { cv_id?: string; label?: string; storage_path?: string; provider?: string };
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

  // ── 4. Structurize the CV in ONE AI call: contact, summary, experience,
  //      education, certifications, references, AND categorised skills all
  //      come back together. Non-fatal — failure leaves structured_cv NULL
  //      and the analysis pipeline falls back to raw cv_text.
  let structuredCv: StructuredCv | null = null;
  let normalizedCvText: string | null = null;
  let categorised: { technical: string[]; soft_skills: string[]; domain_knowledge: string[] } | null = null;
  const { data: keyRows } = await admin
    .from("user_integrations")
    .select("provider, encrypted_api_key, config")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true)
    .in("provider", PROVIDER_PRIORITY as unknown as string[]);
  type KeyRow = { provider: Provider; encrypted_api_key: string; config: { model?: string } | null };
  const keyByProvider = new Map<Provider, KeyRow>();
  for (const row of (keyRows ?? []) as KeyRow[]) keyByProvider.set(row.provider, row);

  const preferredProvider = (body.provider && PROVIDER_PRIORITY.includes(body.provider as Provider))
    ? (body.provider as Provider)
    : null;

  const chosen = (preferredProvider && keyByProvider.has(preferredProvider))
    ? preferredProvider
    : PROVIDER_PRIORITY.find((p) => keyByProvider.has(p));

  if (chosen) {
    const k = keyByProvider.get(chosen)!;
    try {
      const apiKey      = decryptApiKey(k.encrypted_api_key);
      const storedModel = k.config?.model ?? null;
      try {
        const r = await structurizeCv({ cv_text: cvText, ai_provider: chosen, ai_api_key: apiKey, ai_model: storedModel });
        structuredCv     = r.structured_cv;
        normalizedCvText = r.normalized_cv_text;
        categorised      = r.structured_cv.skills;
      } catch (firstErr) {
        if (storedModel) {
          console.warn("[/api/cv POST] structurize with stored model failed, retrying default:", firstErr);
          const r = await structurizeCv({ cv_text: cvText, ai_provider: chosen, ai_api_key: apiKey, ai_model: null });
          structuredCv     = r.structured_cv;
          normalizedCvText = r.normalized_cv_text;
          categorised      = r.structured_cv.skills;
        } else {
          throw firstErr;
        }
      }
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

  // Forced redirect: a freshly-parsed CV must be reviewed before it's used.
  // When structurization failed (no key, AI error), skip the review and behave
  // like the legacy flow — analysis still works against the raw cv_text.
  const redirect_to = structuredCv ? `/dashboard/cv/${cv_id}/review` : null;

  const responseRow = row as Record<string, unknown>;
  return NextResponse.json({
    ...responseRow,
    word_count:         cvText.split(/\s+/).length,
    has_categorisation: categorised !== null,
    redirect_to,
  });
}
