/**
 * Application-email dispatch — the full business logic behind
 * POST /api/applications/[letter_id]/send-email, extracted verbatim from
 * the route (2026-07-23 audit batch 5) so the route stays a thin shell.
 *
 * Flow: multipart/JSON body (subject/body overrides + optional client-
 * rendered CV PDF) → letter + job ownership gates → CV/letter PDF
 * resolution → OAuth token → Gmail/Outlook dispatch → sent stamps.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { getValidAccessToken }        from "@/lib/email/tokens";
import { sendViaGmail }               from "@/lib/email/gmail";
import { sendViaOutlook }             from "@/lib/email/outlook";
import { ensureCoverLetterPdf }       from "@/lib/coverLetterPdfStore";
import { buildDefaultEmailDraft }    from "@/lib/email/draftBody";
import { emitEvent }                 from "@/lib/admin/events";
import type { ContactDetails }       from "@/lib/types";
import { jsonError } from "@/lib/api-utils";
import { MAX_APPLICATION_BODY_LEN, MAX_APPLICATION_SUBJECT_LEN, TAILORED_CV_BUCKET } from "@/lib/constants";

const MAX_SUBJECT_LEN = MAX_APPLICATION_SUBJECT_LEN;
const MAX_BODY_LEN    = MAX_APPLICATION_BODY_LEN;
const MAX_CV_PDF_BYTES = 4 * 1024 * 1024;  // 4 MB — generous; a typical CV is ~80-200KB

/**
 * Records the sent-email stamps after a successful send. Both writes are
 * checked for {error} — B2-P2 (audit): the old code fired both via a bare
 * Promise.all with no check at all. The email has already been
 * irreversibly sent by this point, so a silent DB failure here isn't just
 * a display nit: pipelineState.ts keys a job's "applied" state SOLELY off
 * jobs.applied_at, so if that write doesn't stick, the job keeps showing
 * as unapplied — inviting the user to generate and send a SECOND cover
 * letter/email for a job an employer was already emailed about (the
 * step-7 claim above only blocks a retry of the SAME letter_id, not a
 * brand-new one). Both failures are logged loudly with letter/job ids so
 * ops can find and manually reconcile a stuck row, rather than the write
 * silently vanishing.
 *
 * Extracted as its own function for testability — mocking the whole send
 * flow (multipart parsing, PDF generation, OAuth, Gmail/Outlook) just to
 * exercise this one post-send bookkeeping step isn't worth it.
 */
export async function recordSentStamps(
  admin: ReturnType<typeof createAdminClient>,
  params: { letterId: string; jobId: string; sentTo: string | null; sentAt: string },
): Promise<{ letterStampOk: boolean; jobStampOk: boolean }> {
  const { letterId, jobId, sentTo, sentAt } = params;
  const [letterStamp, jobStamp] = await Promise.all([
    admin
      .from("cover_letters")
      .update({ email_sent_at: sentAt, email_sent_to: sentTo })
      .eq("id", letterId),
    admin
      .from("jobs")
      .update({ applied_at: sentAt })
      .eq("id", jobId),
  ]);
  if (letterStamp.error) {
    console.error(
      `[send-email] POST-SEND STAMP FAILED (cover_letters) — letter ${letterId} was emailed but its sent-at/sent-to record did not persist:`,
      letterStamp.error.message,
    );
  }
  if (jobStamp.error) {
    console.error(
      `[send-email] POST-SEND STAMP FAILED (jobs.applied_at) — job ${jobId} may still show as unapplied despite letter ${letterId} having been emailed; a duplicate application could be sent:`,
      jobStamp.error.message,
    );
  }
  return { letterStampOk: !letterStamp.error, jobStampOk: !jobStamp.error };
}


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
        // Only kept when it actually has bytes. An empty Buffer is still a
        // truthy object, so assigning one would satisfy the `!cvPdfBuffer`
        // check further down and attach a 0-byte CV — the same silent-bad-send
        // that check exists to prevent. Null instead, so the legacy storage
        // path gets a look and the guard can fire.
        clientCvPdfBuffer = buf.length > 0 ? buf : null;
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
  // Whether this job is SUPPOSED to have a CV attached. A job that was never
  // tailored legitimately has nothing to send; a job that was tailored and
  // arrives here with no bytes is a failure, not a variation.
  let expectsCv = false;

  if (!cvPdfBuffer) {
    const { data: run } = await admin
      .from("analysis_runs")
      .select("tailored_pdf_storage_path, tailored_cv_storage_path")
      .eq("job_id", letter.job_id)
      .eq("user_id", user.id)
      .eq("is_stale", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expectsCv = !!(run?.tailored_pdf_storage_path || run?.tailored_cv_storage_path);

    if (run?.tailored_pdf_storage_path) {
      const { data: pdfData } = await admin
        .storage
        .from(TAILORED_CV_BUCKET)
        .download(run.tailored_pdf_storage_path);
      if (pdfData) {
        // Same zero-length reasoning as the client upload above.
        const buf = Buffer.from(await pdfData.arrayBuffer());
        cvPdfBuffer = buf.length > 0 ? buf : null;
      }
    }
  }

  // Refuse rather than quietly send a worse application.
  //
  // This used to fall through: no client PDF, storage download fails or the
  // legacy path is null, and the email went out with the cover letter alone —
  // no error, "Application sent ✓". The next line claims `email_sent_at`, and
  // from that moment FOUR paths 409 (send-email pre-flight, the atomic claim,
  // PATCH letter, POST review). So the one send the user gets is the broken
  // one and the correct version can never go out, from anywhere in the app.
  //
  // Failing here costs a retry. Sending here costs the application.
  if (!cvPdfBuffer && expectsCv) {
    return jsonError(
      "Your tailored CV couldn't be attached, so nothing was sent — the application is "
      + "unchanged and you can try again. If this keeps happening, open the job and use "
      + "Download to check the CV still generates.",
      422,
    );
  }

  // ── 4b. Generate (or fetch) cover letter PDF (Phase G) ──────────────────
  // ensureCoverLetterPdf is idempotent: returns existing path+bytes when the
  // PDF was already rendered, otherwise renders, uploads, and stamps the path.
  let letterPdfBuffer: Buffer | null = null;
  try {
    const ensured = await ensureCoverLetterPdf(letter_id, user.id);
    // Zero bytes is a failed render that didn't throw — an empty attachment is
    // no better than a missing one, so treat the two the same.
    letterPdfBuffer = ensured.bytes.length > 0 ? ensured.bytes : null;
  } catch (err) {
    console.warn(
      "[send-email] cover letter PDF generation failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Refuse, exactly as the CV does one block up. This was the other half of
  // that bug and it outlived the first fix.
  //
  // It was treated as non-fatal on the stated grounds that we would "send with
  // cover letter as email body only". That is not what happens. The outgoing
  // body is a short covering note that POINTS AT the attachments — "Please find
  // my tailored CV and cover letter attached... The cover letter sets out, in
  // more detail, how my experience maps to the responsibilities" — and
  // buildDefaultEmailDraft is written deliberately NOT to duplicate the letter
  // (see its own comment). So the employer got an email citing a cover letter
  // that wasn't attached, `email_sent_at` was stamped regardless, and from then
  // on the same four paths 409: the user could never send the intact version.
  //
  // Gated on the letter having text, mirroring `expectsCv`: a row with no
  // pass_3_final has no letter to attach and never did, which is a different
  // situation from one whose render failed.
  //
  // Placed before the atomic claim below, so a refusal leaves no stamp to
  // roll back and the retry is clean.
  if (!letterPdfBuffer && (letter.pass_3_final ?? "").trim()) {
    return jsonError(
      "Your cover letter couldn't be attached, so nothing was sent — the application is "
      + "unchanged and you can try again. The email would have referred the employer to a "
      + "cover letter that wasn't there.",
      422,
    );
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
    // C67: this release's own result was discarded — if IT also fails
    // (transient DB error, network blip), email_sent_at stays stamped from
    // the claim above even though no email was ever sent. The next attempt
    // then always fails step 7's `is("email_sent_at", null)` check with
    // "Email already sent" (409) — the application is permanently stuck,
    // since retrying is exactly what can never work once the claim itself
    // can't be released. Distinguished here so the user gets an honest
    // "contact support" message instead of a misleading "try again".
    const { error: releaseError } = await admin
      .from("cover_letters")
      .update({ email_sent_at: null })
      .eq("id", letter_id);
    console.error("[send-email] send failed:", err instanceof Error ? err.message : String(err));
    if (releaseError) {
      console.error(
        "[send-email] CRITICAL: send failed AND releasing the claim also failed — " +
        `letter ${letter_id} is stuck with email_sent_at set but no email sent:`,
        releaseError.message,
      );
      return jsonError("Send failed and this application is now stuck — please contact support.", 500);
    }
    return jsonError("Send failed — please try again.", 502);
  }

  // ── 9. Record recipient + mark applied ───────────────────────────────────
  const now = new Date().toISOString();

  await recordSentStamps(admin, {
    letterId: letter_id,
    jobId:    letter.job_id,
    sentTo:   job.contact_email,
    sentAt:   now,
  });

  // C67: `after()` instead of a bare `void` — see analyze/start.ts's note on
  // this same class of bug (serverless can freeze right after the response,
  // silently dropping an un-awaited fire-and-forget promise).
  after(() => emitEvent({
    userId:    user.id,
    eventType: "email_sent",
    metadata:  { letter_id, job_id: letter.job_id, to: job.contact_email },
  }));

  return NextResponse.json({ sent: true, to: job.contact_email });
}
