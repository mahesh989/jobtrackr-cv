/**
 * GET /api/applications/[letter_id]/email-draft
 *
 * Returns the prefilled email draft the user will review in the compose modal
 * BEFORE clicking Send. The draft is computed server-side from job + user
 * preferences so the recipient/subject/body shown in the modal exactly match
 * what /send-email would have used if called with no overrides.
 *
 * Ownership: cover_letters.user_id is the authoritative gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { buildDefaultEmailDraft }    from "@/lib/email/draftBody";
import { getActiveAiCredentials }    from "@/lib/ai/activeProvider";
import { voiceRewriteEmail }         from "@/lib/cv/backend";
import type { ContactDetails }       from "@/lib/types";
import { jsonError, withUser } from "@/lib/api-utils";

const TAILORED_CV_BUCKET = "tailored-cvs";

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
  { user },
) => {

  const { letter_id } = await params;
  const admin = createAdminClient();

  // 1. Letter (ownership gate + has-it-been-sent guard)
  const { data: letter } = await admin
    .from("cover_letters")
    .select("id, user_id, job_id, email_sent_at, reviewed_at, email_subject, email_body")
    .eq("id", letter_id)
    .maybeSingle();

  if (!letter || letter.user_id !== user.id) {
    return jsonError("Letter not found", 404);
  }
  if (letter.email_sent_at) {
    return jsonError("Email already sent", 409);
  }

  // 2. Job (no user_id column — letter ownership is the gate)
  const { data: job } = await admin
    .from("jobs")
    .select("id, title, company, contact_email, hiring_manager")
    .eq("id", letter.job_id)
    .maybeSingle();

  if (!job) {
    return jsonError("Job not found", 404);
  }
  // Contact email is OPTIONAL. The review flow drafts an email regardless;
  // when no contact_email is on file, the resulting draft is for the user
  // to copy and paste into their own mail client.

  // 3. Contact details from preferences — name for the signoff AND the full
  //    contact block which the modal re-stamps onto the CV markdown before
  //    rendering (so the attached PDF reflects whatever the user has saved
  //    NOW, not whatever was there when the analysis originally ran).
  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  const contactDetails = (prefs?.contact_details as ContactDetails | null) ?? null;
  const userName = (contactDetails?.name ?? "").trim() || null;

  // 4. Latest non-stale analysis run — for the CV markdown path. We want the
  //    markdown (not the legacy pdf_storage_path), because the modal renders
  //    fresh client-side using the same pipeline as the analysis page.
  const { data: run } = await admin
    .from("analysis_runs")
    .select("tailored_cv_storage_path")
    .eq("job_id", letter.job_id)
    .eq("user_id", user.id)
    .eq("is_stale", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cvMarkdownPath = run?.tailored_cv_storage_path ?? null;

  // 4b. Pull the markdown contents so the modal doesn't need a Storage round-trip.
  //     A tailored CV is ~5-10KB of text — safe to inline in the response.
  let cvMarkdown: string | null = null;
  if (cvMarkdownPath) {
    const { data: mdBlob } = await admin.storage.from(TAILORED_CV_BUCKET).download(cvMarkdownPath);
    if (mdBlob) cvMarkdown = await mdBlob.text();
  }
  const hasTailoredCv = !!cvMarkdown;

  // 5. Build the default subject/body.
  const defaults = buildDefaultEmailDraft({
    jobTitle:      job.title,
    company:       job.company,
    hiringManager: job.hiring_manager,
    userName,
  });
  const subject = (letter.email_subject ?? "").trim() || defaults.subject;

  // 5b. Body resolution. Three tiers, highest priority first:
  //
  //   (1) letter.email_body — cached AND reviewed_at IS NOT NULL. The
  //       user has approved this body. Always trust it; never re-run AI.
  //
  //   (2) voice-rewritten boilerplate. If a voice_sample_raw is on file
  //       AND the user has an AI key, ask cv-backend to rewrite the
  //       default boilerplate in their style (style transfer, NOT
  //       free-form generation — meaning is preserved). Cache the
  //       result in letter.email_body so subsequent loads are instant.
  //
  //   (3) buildDefaultEmailDraft boilerplate — used when no voice
  //       sample / no AI key, or when the voice rewrite fails.
  //
  // KEY DIFFERENCE FROM PREVIOUS VERSION: an UN-reviewed cached body
  // (email_body set but reviewed_at null) is NO LONGER trusted — it
  // gets re-rewritten on every modal open. This auto-heals the bad
  // rewrites left over from the old prompt that lifted content from
  // the voice sample. Once the user approves a body (reviewed_at set),
  // their approval is final and tier 1 takes over.
  const hasApprovedBody = !!letter.email_body && !!letter.reviewed_at;
  let body: string = hasApprovedBody ? letter.email_body! : "";
  let voiceRewritten = hasApprovedBody;

  if (!body) {
    body = defaults.body;
    voiceRewritten = false;

    // Try the voice rewrite.
    const [{ data: voiceRow }, creds] = await Promise.all([
      admin
        .from("voice_profiles")
        .select("voice_sample_raw")
        .eq("user_id", user.id)
        .maybeSingle(),
      getActiveAiCredentials(),
    ]);

    const voiceSample = (voiceRow?.voice_sample_raw ?? "").trim();
    const chosen = creds?.provider;

    if (voiceSample && chosen && creds) {
      try {
        const apiKey = creds.apiKey;
        const result = await voiceRewriteEmail({
          user_id:           user.id,
          letter_id:         letter.id,
          job_title:         job.title ?? "the role",
          company:           job.company ?? "your organisation",
          hiring_manager:    job.hiring_manager ?? null,
          user_name:         userName,
          voice_sample_text: voiceSample,
          // Style-transfer source-of-truth. The AI rewrites this in the
          // user's voice without changing what it says.
          boilerplate_body:  defaults.body,
          ai_provider:       chosen,
          ai_api_key:        apiKey,
          ai_model:          creds.model ?? undefined,
        });
        const rewritten = (result.body ?? "").trim();
        if (rewritten) {
          body = rewritten;
          voiceRewritten = true;
          // Cache it. We DO NOT touch reviewed_at — the user hasn't
          // approved yet; this is just a smarter default.
          await admin
            .from("cover_letters")
            .update({ email_body: rewritten })
            .eq("id", letter.id);
        }
      } catch (err) {
        // Non-fatal — boilerplate fallback is already loaded above.
        console.warn("[email-draft] voice rewrite failed, falling back to boilerplate:", err);
      }
    }
  }

  // toDisplay is the human-readable "To:" string shown in the modal. When no
  // contact_email is set, return a placeholder rather than the literal
  // string "null" — the modal hides the recipient field for those cards.
  const toDisplay = job.contact_email
    ? (job.hiring_manager ? `${job.hiring_manager} <${job.contact_email}>` : job.contact_email)
    : "(no recipient — copy & send from your own client)";

  const companySlug = (job.company ?? "company").replace(/[^a-zA-Z0-9]/g, "_");
  const attachments: string[] = [`CoverLetter_${companySlug}.pdf`];
  if (hasTailoredCv) attachments.push(`TailoredCV_${companySlug}.pdf`);

  return NextResponse.json({
    to:              toDisplay,
    to_email:        job.contact_email,
    hiring_manager:  job.hiring_manager,
    job_title:       job.title,
    job_company:     job.company,
    user_name:       userName,
    subject,
    body,
    attachments,
    has_tailored_cv: hasTailoredCv,
    voice_rewritten: voiceRewritten,
    reviewed_at:     letter.reviewed_at,
    // Payload for client-side CV PDF render. Both null = modal sends with
    // cover letter only (no CV attached). Strips the projects sub-array
    // since it's not part of the contact block.
    cv_markdown:     cvMarkdown,
    contact_details: contactDetails
      ? (() => {
          const { name, phone, email, address, linkedin, github, website, portfolio, other_label, other_url } = contactDetails;
          return { name, phone, email, address, linkedin, github, website, portfolio, other_label, other_url };
        })()
      : null,
  });
});
