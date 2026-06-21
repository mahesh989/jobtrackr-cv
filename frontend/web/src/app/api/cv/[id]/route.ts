/**
 * /api/cv/[id]
 *
 * PATCH  — toggle is_active. Body: { is_active: true } sets this CV as active
 *          and deactivates all others for the user. is_active=false simply
 *          clears the flag (user is left with zero active CVs).
 *
 * DELETE — remove the row and the underlying Storage object. If the deleted
 *          CV was active, the user is left with zero active CVs (Option B).
 *
 * GET    — single CV detail (metadata + signed download URL valid for 5 min).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { ensureSomeoneActive }       from "@/lib/cv/ensureActive";

const SIGNED_URL_TTL_SECONDS = 300;

async function authedUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cv_versions")
    .select("id, label, pdf_storage_path, is_active, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[/api/cv/:id] db error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
  if (!data)  return NextResponse.json({ error: "CV not found" }, { status: 404 });

  // Generate a short-lived signed URL so the browser can render the PDF.
  const { data: signed } = await admin
    .storage
    .from("cvs")
    .createSignedUrl(data.pdf_storage_path, SIGNED_URL_TTL_SECONDS);

  return NextResponse.json({ ...data, signed_url: signed?.signedUrl ?? null });
}

// ── PATCH — set/unset active ─────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { is_active?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  if (typeof body.is_active !== "boolean") {
    return NextResponse.json({ error: "Body must include is_active: boolean" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify ownership first
  const { data: owned } = await admin
    .from("cv_versions")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: "CV not found" }, { status: 404 });

  if (body.is_active) {
    // Deactivate any currently active row first — the partial unique index
    // would otherwise reject the UPDATE. Two-step is fine because Supabase
    // service-role bypasses RLS and there's only one user mutating their
    // own rows at a time in practice.
    const { error: deactivateErr } = await admin
      .from("cv_versions")
      .update({ is_active: false })
      .eq("user_id", user.id)
      .eq("is_active", true);
    if (deactivateErr) {
      console.error("[/api/cv/:id] deactivate error:", deactivateErr.message);
      return NextResponse.json({ error: "Request failed" }, { status: 500 });
    }
  }

  const { error: setErr } = await admin
    .from("cv_versions")
    .update({ is_active: body.is_active })
    .eq("id", id);
  if (setErr) {
    console.error("[/api/cv/:id] set-active error:", setErr.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }

  // If the user just deactivated their only active CV, auto-promote a
  // remaining one so they never end up in a "no active CV" state when CVs
  // still exist in their library.
  if (!body.is_active) await ensureSomeoneActive(admin, user.id);

  return NextResponse.json({ id, is_active: body.is_active });
}

// ── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const admin = createAdminClient();

  // Look up the row so we know which Storage object to remove.
  const { data: row } = await admin
    .from("cv_versions")
    .select("pdf_storage_path")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "CV not found" }, { status: 404 });

  // Best-effort Storage cleanup — if it fails we still delete the row so the
  // user can recover, but log it for visibility. "Built in app" CVs (built://…)
  // have no Storage object, so skip the remove entirely.
  if (row.pdf_storage_path && row.pdf_storage_path !== "pending" && !row.pdf_storage_path.startsWith("built://")) {
    const { error: storageErr } = await admin.storage.from("cvs").remove([row.pdf_storage_path]);
    if (storageErr) {
      console.warn("[/api/cv/:id DELETE] storage remove failed:", storageErr.message);
    }
  }

  const { error } = await admin.from("cv_versions").delete().eq("id", id);
  if (error) {
    console.error("[/api/cv/:id] db error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }

  // If the deleted CV was the active one and there are other CVs left,
  // promote the most recent one so the user always has an active CV when
  // any CVs exist.
  await ensureSomeoneActive(admin, user.id);

  return NextResponse.json({ deleted: true });
}
