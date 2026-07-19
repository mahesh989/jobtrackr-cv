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
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { revalidatePath }            from "next/cache";

const MAX_SUBJECT_LEN = 300;
const MAX_BODY_LEN    = 20_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { letter_id } = await params;

  let body: { subject?: string; body?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const subject = (body.subject ?? "").trim();
  const message = body.body ?? "";

  if (!subject)                       return NextResponse.json({ error: "Subject is required" }, { status: 400 });
  if (subject.length > MAX_SUBJECT_LEN) return NextResponse.json({ error: `Subject too long (>${MAX_SUBJECT_LEN})` }, { status: 400 });
  if (!message.trim())                return NextResponse.json({ error: "Body is required" }, { status: 400 });
  if (message.length > MAX_BODY_LEN)  return NextResponse.json({ error: `Body too long (>${MAX_BODY_LEN})` }, { status: 400 });

  const admin = createAdminClient();

  // Ownership gate + has-it-been-sent guard.
  const { data: existing } = await admin
    .from("cover_letters")
    .select("user_id, email_sent_at")
    .eq("id", letter_id)
    .maybeSingle();

  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }
  if (existing.email_sent_at) {
    return NextResponse.json({ error: "Email has already been sent — review is no longer applicable" }, { status: 409 });
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
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }

  // Refresh the applications listing so the card moves tabs immediately.
  revalidatePath("/applications");
  return NextResponse.json({ reviewed: true });
}
