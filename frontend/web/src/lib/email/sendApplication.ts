/**
 * Application-email dispatch — the full business logic behind
 * POST /api/applications/[letter_id]/send-email, extracted verbatim from
 * the route (2026-07-23 audit batch 5) so the route stays a thin shell.
 *
 * Flow: multipart/JSON body (subject/body overrides + optional client-
 * rendered CV PDF) → letter + job ownership gates → CV/letter PDF
 * resolution → OAuth token → Gmail/Outlook dispatch → sent stamps.
 */

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { getValidAccessToken }        from "@/lib/email/tokens";
import { sendViaGmail }               from "@/lib/email/gmail";
import { sendViaOutlook }             from "@/lib/email/outlook";
import { ensureCoverLetterPdf }       from "@/lib/coverLetterPdfStore";
import { buildDefaultEmailDraft }    from "@/lib/email/draftBody";
import { emitEvent }                 from "@/lib/admin/events";
import type { ContactDetails }       from "@/lib/types";
import { jsonError } from "@/lib/api-utils";

const TAILORED_CV_BUCKET = "tailored-cvs";
const MAX_SUBJECT_LEN = 300;
const MAX_BODY_LEN    = 20_000;
const MAX_CV_PDF_BYTES = 4 * 1024 * 1024;  // 4 MB — generous; a typical CV is ~80-200KB


/** Everything after auth + param resolution. Returns the route response. */
export async function sendApplicationEmail(
  req: NextRequest,
  letterId: string,
  user: { id: string },
): Promise<Response> {
  const letter_id = letterId;

  // The compose modal POSTs multipart/form-data with subject + body + an
  // optional cv_pdf blob (client-rendered to match the analysis-page CV).
  // We still accept JSON for backward compatibility with any callers that
  // haven't switched over.
  let override: { subject?: string; body?: string } = {};
  let clientCvPdfBuffer: Buffer | null = null;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const subjectField = form.get("subject");
      const bodyField    = form.get("body");
      const cvField      = form.get("cv_pdf");
      if (typeof subjectField === "string") override.subject = subjectField;
      if (typeof bodyField    === "string") override.body    = bodyField;
      if (cvField && typeof cvField === "object" && "arrayBuffer" in cvField) {
        const buf = Buffer.from(await cvField.arrayBuffer());
        if (buf.length > MAX_CV_PDF_BYTES) {
          return jsonError(`Tailored CV PDF too large (>${MAX_CV_PDF_BYTES} bytes)`, 413);
        }
        clientCvPdfBuffer = buf;
      }
    } catch {
      return jsonError("Invalid multipart body", 400);
    }
  } else {
    try {
      const text = await req.text();
      if (text.trim()) override = JSON.parse(text);
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
  }
  if (override.subject != null && (typeof override.subject !== "string" || override.subject.length > MAX_SUBJECT_LEN)) {
    return jsonError(`Subject must be a string under ${MAX_SUBJECT_LEN} chars`, 400);
  }
  if (override.body != null && (typeof override.body !== "string" || override.body.length > MAX_BODY_LEN)) {
    return jsonError(`Body must be a string under ${MAX_BODY_LEN} chars`, 400);
  }

  const admin = createAdminClient();

  // ── 1. Fetch cover letter ────────────────────────────────────────────────
  const { data: letter, error: lErr } = await admin
    .from("cover_letters")
    .select("id, user_id, job_id, pass_3_final, email_sent_at, email_subject, email_body")
    .eq("id", letter_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (lErr || !letter) {
    return jsonError("Letter not found", 404);
  }
  if (letter.email_sent_at) {
    return jsonError("Email already sent", 409);
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
    console.error("[send-email] job lookup failed:", jobErr.message);
    return jsonError("Job lookup failed", 500);
  }
  if (!job) {
    return jsonError("Job not found for this letter", 404);
  }
  if (!job.contact_email) {
    return jsonError("Job has no contact email — add one in the pool first", 422);
  }

  // ── 3+4. Tailored CV PDF source ───────────────────────────────────────────
  // Preference order:
  //   (a) clientCvPdfBuffer — multipart upload from the compose modal,
  //       rendered in the user's browser using the SAME html2canvas+jsPDF
  //       pipeline as the analysis-page Download PDF button. Guarantees the
  //       outgoing attachment matches what the user previewed.
  //   (b) Legacy fallback — analysis_runs.tailored_pdf_storage_path, the
  //       server-rendered PDF written by cv-backend at analysis time.
  //       Kept for backward-compat (older callers / no-multipart paths);
  //       does NOT match the analysis-tab render but is better than no CV.
  let cvPdfBuffer: Buffer | null = clientCvPdfBuffer;

  if (!cvPdfBuffer) {
    const { data: run } = await admin
      .from("analysis_runs")
      .select("tailored_pdf_storage_path")
      .eq("job_id", letter.job_id)
      .eq("user_id", user.id)
      .eq("is_stale", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (run?.tailored_pdf_storage_path) {
      const { data: pdfData } = await admin
        .storage
        .from(TAILORED_CV_BUCKET)
        .download(run.tailored_pdf_storage_path);
      if (pdfData) {
        cvPdfBuffer = Buffer.from(await pdfData.arrayBuffer());
      }
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
  // Resolution order for the outgoing subject + body:
  //   1. multipart/JSON override from this request (compose modal still open)
  //   2. cover_letters.email_subject/email_body (approved during review)
  //   3. buildDefaultEmailDraft (zero-review fallback for older callers)
  const subject =
    override.subject?.trim()
    || (letter.email_subject ?? "").trim()
    || defaults.subject;
  const body =
    (override.body != null ? override.body : null)
    ?? letter.email_body
    ?? defaults.body;

  const toAddress = job.hiring_manager
    ? `${job.hiring_manager} <${job.contact_email}>`
    : job.contact_email;

  const companyName = job.company ?? "company";
  const companySlug = (companyName ?? "company").replace(/[^a-zA-Z0-9]/g, "_");
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

  // ── 7. Claim the send atomically ─────────────────────────────────────────
  // Stamp email_sent_at only if it is still null. Two concurrent requests would
  // otherwise both pass the step-1 check and both dispatch — this conditional
  // update lets exactly one win. We roll it back below if the send itself fails.
  const claimAt = new Date().toISOString();
  const { data: claimed } = await admin
    .from("cover_letters")
    .update({ email_sent_at: claimAt })
    .eq("id", letter_id)
    .is("email_sent_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    return jsonError("Email already sent", 409);
  }

  // ── 8. Send ───────────────────────────────────────────────────────────────
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
    // Send failed — release the claim so the user can retry.
    await admin
      .from("cover_letters")
      .update({ email_sent_at: null })
      .eq("id", letter_id);
    console.error("[send-email] send failed:", err instanceof Error ? err.message : String(err));
    return jsonError("Send failed — please try again.", 502);
  }

  // ── 9. Record recipient + mark applied ───────────────────────────────────
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

  void emitEvent({
    userId:    user.id,
    eventType: "email_sent",
    metadata:  { letter_id, job_id: letter.job_id, to: job.contact_email },
  });

  return NextResponse.json({ sent: true, to: job.contact_email });
}
