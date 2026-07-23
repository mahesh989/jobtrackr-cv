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
import { createAdminClient }         from "@/lib/supabase/admin";
import { jsonError, withUser } from "@/lib/api-utils";

const ALLOWED_EXT = new Set(["pdf", "docx"]);

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {

  let body: { ext?: string };
  try { body = await req.json(); }
  catch { return jsonError("Invalid JSON body", 400); }

  const ext = (body.ext ?? "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return jsonError(`Unsupported extension '${ext}'`, 400);
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
});
