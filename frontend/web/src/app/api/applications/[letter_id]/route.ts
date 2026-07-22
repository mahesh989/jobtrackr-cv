/**
 * /api/applications/[letter_id]
 *
 * GET   — fetch the full cover letter body for editing
 * PATCH — update the letter body (pass_3_final) and invalidate any cached PDF
 *
 * Ownership: cover_letters has RLS scoping rows to user_id = auth.uid().
 * We additionally verify letter.user_id === user.id as a defence-in-depth.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { withUser } from "@/lib/api-utils";

const MAX_LETTER_LEN = 20_000;   // generous — typical cover letter is ~2KB
const MIN_LETTER_LEN = 50;       // some minimum sanity check

// ── GET ──────────────────────────────────────────────────────────────────────

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
  { user },
) => {

  const { letter_id } = await params;
  const admin = createAdminClient();

  const { data: letter, error } = await admin
    .from("cover_letters")
    .select("id, user_id, pass_3_final, email_sent_at, completed_at")
    .eq("id", letter_id)
    .maybeSingle();

  if (error) {
    console.error("[/api/applications/:letter_id GET] db error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
  if (!letter || letter.user_id !== user.id) {
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }

  return NextResponse.json({
    id:            letter.id,
    pass_3_final:  letter.pass_3_final ?? "",
    email_sent_at: letter.email_sent_at,
    completed_at:  letter.completed_at,
  });
});

// ── PATCH ────────────────────────────────────────────────────────────────────

export const PATCH = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> }, { user }) => {

  const { letter_id } = await params;

  let body: { pass_3_final?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const newText = (body.pass_3_final ?? "").trim();
  if (newText.length < MIN_LETTER_LEN) {
    return NextResponse.json({ error: `Letter body too short (min ${MIN_LETTER_LEN} chars)` }, { status: 400 });
  }
  if (newText.length > MAX_LETTER_LEN) {
    return NextResponse.json({ error: `Letter body too long (max ${MAX_LETTER_LEN} chars)` }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify ownership and that the letter hasn't already been sent.
  // Edits to already-sent letters wouldn't change anything (the email is out)
  // — block to avoid confusing users into thinking the change "took effect".
  const { data: existing } = await admin
    .from("cover_letters")
    .select("user_id, email_sent_at, pdf_storage_path")
    .eq("id", letter_id)
    .maybeSingle();

  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }
  if (existing.email_sent_at) {
    return NextResponse.json({ error: "Cannot edit a letter that has already been sent" }, { status: 409 });
  }

  // Stamp the new body. Clear pdf_storage_path so the next Letter download
  // or Send-email lazy-regenerates the PDF from the edited text.
  // Also clear reviewed_at: editing the letter invalidates the prior review
  // (the approved email subject/body referenced the old text); the user
  // should re-review before the card moves to Ready to apply again.
  // Note: we leave the existing Storage object in place — it will be
  // overwritten by ensureCoverLetterPdf's upsert on the next request.
  const { error: patchErr } = await admin
    .from("cover_letters")
    .update({
      pass_3_final:     newText,
      pdf_storage_path: null,
      reviewed_at:      null,
    })
    .eq("id", letter_id);

  if (patchErr) {
    console.error("[/api/applications/:letter_id PATCH] db error:", patchErr.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }

  return NextResponse.json({ updated: true, length: newText.length });
});
