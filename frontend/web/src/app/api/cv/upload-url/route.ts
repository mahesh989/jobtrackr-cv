/**
 * /api/cv/upload-url
 *
 * Mints a one-time signed upload URL for a new CV. The browser then PUTs the
 * file bytes directly to that URL — no Vercel function involvement, no
 * Authorization header on the upload itself (the URL is pre-signed).
 *
 * This avoids the issue where the regular supabase-js storage.upload() POST
 * gets ERR_TIMED_OUT at the network edge for some file/region combinations.
 *
 * Flow:
 *   1. Browser POSTs { ext: 'pdf'|'docx' }
 *   2. Server allocates cv_id, builds storage_path = '{user_id}/{cv_id}.{ext}'
 *   3. Server uses service-role to call createSignedUploadUrl()
 *   4. Returns { cv_id, storage_path, signed_url, token }
 *   5. Browser uploads to signed_url, then calls /api/cv POST to finalise
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";

const ALLOWED_EXT = new Set(["pdf", "docx"]);

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { ext?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const ext = (body.ext ?? "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: `Unsupported extension '${ext}'` }, { status: 400 });
  }

  const cv_id        = crypto.randomUUID();
  const storage_path = `${user.id}/${cv_id}.${ext}`;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("cvs")
    .createSignedUploadUrl(storage_path);

  if (error || !data) {
    console.error("[/api/cv/upload-url] createSignedUploadUrl failed:", error?.message);
    return NextResponse.json(
      { error: error?.message ?? "Failed to mint upload URL" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    cv_id,
    storage_path,
    signed_url: data.signedUrl,
    token:      data.token,
  });
}
