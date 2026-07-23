/**
 * POST /api/applications/[letter_id]/review
 *
 * User has reviewed the compose modal and clicked Approve. Stores the
 * approved subject + body and stamps reviewed_at so the card moves from
 * the Review stage ("Ready to email") to the Send stage ("Ready to apply"
 * for email-channel rows).
 *
 * No email is dispatched here — see /send-email for that.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { revalidatePath }            from "next/cache";
import { jsonError, withUser } from "@/lib/api-utils";

const MAX_SUBJECT_LEN = 300;
const MAX_BODY_LEN    = 20_000;

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
  { user },
) => {

  const { letter_id } = await params;

  let body: { subject?: string; body?: string };
  try { body = await req.json(); }
  catch { return jsonError("Invalid JSON body", 400); }

  const subject = (body.subject ?? "").trim();
  const message = body.body ?? "";

  if (!subject)                       return jsonError("Subject is required", 400);
  if (subject.length > MAX_SUBJECT_LEN) return jsonError(`Subject too long (>${MAX_SUBJECT_LEN})`, 400);
  if (!message.trim())                return jsonError("Body is required", 400);
  if (message.length > MAX_BODY_LEN)  return jsonError(`Body too long (>${MAX_BODY_LEN})`, 400);

  const admin = createAdminClient();

  // Ownership gate + has-it-been-sent guard.
  const { data: existing } = await admin
    .from("cover_letters")
    .select("user_id, email_sent_at")
    .eq("id", letter_id)
    .maybeSingle();

  if (!existing || existing.user_id !== user.id) {
    return jsonError("Letter not found", 404);
  }
  if (existing.email_sent_at) {
    return jsonError("Email has already been sent — review is no longer applicable", 409);
  }

  const { error: updErr } = await admin
    .from("cover_letters")
    .update({
      email_subject: subject,
      email_body:    message,
      reviewed_at:   new Date().toISOString(),
    })
    .eq("id", letter_id);

  if (updErr) {
    console.error("[review] update failed:", updErr.message);
    return jsonError("Save failed", 500);
  }

  // Refresh the applications listing so the card moves tabs immediately.
  revalidatePath("/applications");
  return NextResponse.json({ reviewed: true });
});
