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
import { ensureCoverLetterPdf }       from "@/lib/coverLetterPdfStore";
import { buildDefaultEmailDraft }    from "@/lib/email/draftBody";

const TAILORED_CV_BUCKET = "tailored-cvs";
const MAX_SUBJECT_LEN = 300;
const MAX_BODY_LEN    = 20_000;

interface ContactDetails { name?: string }

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { letter_id } = await params;

  // Optional overrides from the compose modal. If neither is provided, fall
  // back to the same draft the modal would have shown (zero-surprise default).
  let override: { subject?: string; body?: string } = {};
  try {
    const text = await req.text();
    if (text.trim()) override = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (override.subject != null && (typeof override.subject !== "string" || override.subject.length > MAX_SUBJECT_LEN)) {
    return NextResponse.json({ error: `Subject must be a string under ${MAX_SUBJECT_LEN} chars` }, { status: 400 });
  }
  if (override.body != null && (typeof override.body !== "string" || override.body.length > MAX_BODY_LEN)) {
    return NextResponse.json({ error: `Body must be a string under ${MAX_BODY_LEN} chars` }, { status: 400 });
  }

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
  // jobs has no direct user_id column — ownership flows through
  // jobs.profile_id → search_profiles.user_id. letter.user_id is the
  // authoritative gate (checked in step 1 above).
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, contact_email, hiring_manager")
    .eq("id", letter.job_id)
    .maybeSingle();

  if (jobErr) {
    console.error("[send-email] job lookup failed:", jobErr);
    return NextResponse.json({ error: `Job lookup failed: ${jobErr.message}` }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "Job not found for this letter" }, { status: 404 });
  }
  if (!job.contact_email) {
    return NextResponse.json({ error: "Job has no contact email — add one in the pool first" }, { status: 422 });
  }

  // ── 3. Fetch latest non-stale analysis run for the PDF path ──────────────
  // analysis_runs HAS a direct user_id column (added by an earlier migration).
  const { data: run } = await admin
    .from("analysis_runs")
    .select("tailored_pdf_storage_path")
    .eq("job_id", letter.job_id)
    .eq("user_id", user.id)
    .eq("is_stale", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── 4. Download tailored CV PDF (best-effort) ───────────────────────────
  let cvPdfBuffer: Buffer | null = null;
  if (run?.tailored_pdf_storage_path) {
    const { data: pdfData } = await admin
      .storage
      .from(TAILORED_CV_BUCKET)
      .download(run.tailored_pdf_storage_path);
    if (pdfData) {
      cvPdfBuffer = Buffer.from(await pdfData.arrayBuffer());
    }
  }

  // ── 4b. Generate (or fetch) cover letter PDF (Phase G) ──────────────────
  // ensureCoverLetterPdf is idempotent: returns existing path+bytes when the
  // PDF was already rendered, otherwise renders, uploads, and stamps the path.
  let letterPdfBuffer: Buffer | null = null;
  try {
    const ensured = await ensureCoverLetterPdf(letter_id, user.id);
    letterPdfBuffer = ensured.bytes;
  } catch (err) {
    // Non-fatal — we'll send with cover letter as email body only.
    console.warn("[send-email] cover letter PDF generation failed (non-fatal):", err);
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
  // The body that goes out is a short email cover note pointing to the two
  // PDF attachments — NOT the full cover letter text (that's already attached
  // as CoverLetter_<company>.pdf). Defaults computed from job + user name;
  // can be overridden by the compose modal payload.
  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  const userName = ((prefs?.contact_details as ContactDetails | null)?.name ?? "").trim() || null;

  const defaults = buildDefaultEmailDraft({
    jobTitle:      job.title,
    company:       job.company,
    hiringManager: job.hiring_manager,
    userName,
  });
  const subject = override.subject?.trim() || defaults.subject;
  const body    = override.body    ?? defaults.body;

  const toAddress = job.hiring_manager
    ? `${job.hiring_manager} <${job.contact_email}>`
    : job.contact_email;

  const companyName = job.company ?? "company";
  const companySlug = companyName.replace(/[^a-zA-Z0-9]/g, "_");
  const attachments = [];
  if (letterPdfBuffer) {
    attachments.push({
      filename:    `CoverLetter_${companySlug}.pdf`,
      contentType: "application/pdf",
      data:        letterPdfBuffer,
    });
  }
  if (cvPdfBuffer) {
    attachments.push({
      filename:    `TailoredCV_${companySlug}.pdf`,
      contentType: "application/pdf",
      data:        cvPdfBuffer,
    });
  }

  // ── 7. Send ───────────────────────────────────────────────────────────────
  try {
    if (tokenInfo.provider === "google") {
      await sendViaGmail(tokenInfo.access_token, {
        from:       tokenInfo.email,
        to:         toAddress,
        subject,
        body,
        attachments,
      });
    } else {
      await sendViaOutlook(tokenInfo.access_token, {
        to:         toAddress,
        subject,
        body,
        attachments,
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
