/**
 * POST /api/applications/[letter_id]/send-email
 *
 * Sends the cover letter for the given letter_id to the job's contact_email.
 * Attaches the tailored CV PDF from Supabase Storage.
 * On success:
 *   - stamps cover_letters.email_sent_at + email_sent_to
 *   - sets jobs.applied_at = now()
 *
 * Requires an active email_integrations row (Gmail or Outlook OAuth).
 */

import { NextRequest, NextResponse }  from "next/server";
import { createClient }               from "@/lib/supabase/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { getValidAccessToken }        from "@/lib/email/tokens";
import { sendViaGmail }               from "@/lib/email/gmail";
import { sendViaOutlook }             from "@/lib/email/outlook";

const TAILORED_CV_BUCKET = "tailored-cvs";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { letter_id } = await params;

  const admin = createAdminClient();

  // ── 1. Fetch cover letter ────────────────────────────────────────────────
  const { data: letter, error: lErr } = await admin
    .from("cover_letters")
    .select("id, user_id, job_id, pass_3_final, email_sent_at")
    .eq("id", letter_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (lErr || !letter) {
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }
  if (letter.email_sent_at) {
    return NextResponse.json({ error: "Email already sent" }, { status: 409 });
  }

  // ── 2. Fetch job ─────────────────────────────────────────────────────────
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, contact_email, hiring_manager")
    .eq("id", letter.job_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!job?.contact_email) {
    return NextResponse.json({ error: "Job has no contact email" }, { status: 422 });
  }

  // ── 3. Fetch latest non-stale analysis run for the PDF path ──────────────
  const { data: run } = await admin
    .from("analysis_runs")
    .select("tailored_pdf_storage_path")
    .eq("job_id", letter.job_id)
    .eq("user_id", user.id)
    .eq("is_stale", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── 4. Download PDF (best-effort — send without attachment if missing) ───
  let pdfBuffer: Buffer | null = null;
  if (run?.tailored_pdf_storage_path) {
    const { data: pdfData } = await admin
      .storage
      .from(TAILORED_CV_BUCKET)
      .download(run.tailored_pdf_storage_path);
    if (pdfData) {
      pdfBuffer = Buffer.from(await pdfData.arrayBuffer());
    }
  }

  // ── 5. Get valid OAuth access token ──────────────────────────────────────
  let tokenInfo: { access_token: string; email: string; provider: "google" | "microsoft" };
  try {
    tokenInfo = await getValidAccessToken(user.id);
  } catch (err) {
    return NextResponse.json(
      { error: `No email account connected: ${err instanceof Error ? err.message : err}` },
      { status: 422 },
    );
  }

  // ── 6. Build email fields ─────────────────────────────────────────────────
  const jobTitle    = job.title    ?? "the role";
  const companyName = job.company  ?? "the company";
  const subject     = `Application for ${jobTitle} at ${companyName}`;
  const body        = letter.pass_3_final ?? "";

  const toAddress   = job.hiring_manager
    ? `${job.hiring_manager} <${job.contact_email}>`
    : job.contact_email;

  const attachment = pdfBuffer
    ? {
        filename:    `TailoredCV_${companyName.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`,
        contentType: "application/pdf",
        data:        pdfBuffer,
      }
    : undefined;

  // ── 7. Send ───────────────────────────────────────────────────────────────
  try {
    if (tokenInfo.provider === "google") {
      await sendViaGmail(tokenInfo.access_token, {
        from:       tokenInfo.email,
        to:         toAddress,
        subject,
        body,
        attachment,
      });
    } else {
      await sendViaOutlook(tokenInfo.access_token, {
        to:         toAddress,
        subject,
        body,
        attachment,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[send-email] send failed:", msg);
    return NextResponse.json({ error: `Send failed: ${msg}` }, { status: 502 });
  }

  // ── 8. Record + mark applied ─────────────────────────────────────────────
  const now = new Date().toISOString();

  await Promise.all([
    admin
      .from("cover_letters")
      .update({ email_sent_at: now, email_sent_to: job.contact_email })
      .eq("id", letter_id),
    admin
      .from("jobs")
      .update({ applied_at: now })
      .eq("id", letter.job_id),
  ]);

  return NextResponse.json({ sent: true, to: job.contact_email });
}
