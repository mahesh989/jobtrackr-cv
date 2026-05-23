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
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { buildDefaultEmailDraft }    from "@/lib/email/draftBody";

interface ContactDetails {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  portfolio?: string;
  other_label?: string;
  other_url?: string;
}

const TAILORED_CV_BUCKET = "tailored-cvs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { letter_id } = await params;
  const admin = createAdminClient();

  // 1. Letter (ownership gate + has-it-been-sent guard)
  const { data: letter } = await admin
    .from("cover_letters")
    .select("id, user_id, job_id, email_sent_at, reviewed_at, email_subject, email_body")
    .eq("id", letter_id)
    .maybeSingle();

  if (!letter || letter.user_id !== user.id) {
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }
  if (letter.email_sent_at) {
    return NextResponse.json({ error: "Email already sent" }, { status: 409 });
  }

  // 2. Job (no user_id column — letter ownership is the gate)
  const { data: job } = await admin
    .from("jobs")
    .select("id, title, company, contact_email, hiring_manager")
    .eq("id", letter.job_id)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
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

  // 5. Build the default draft — but if the user has already reviewed and
  //    saved a subject/body, prefer those so the modal shows what they
  //    approved earlier rather than throwing it away on re-open.
  const defaults = buildDefaultEmailDraft({
    jobTitle:      job.title,
    company:       job.company,
    hiringManager: job.hiring_manager,
    userName,
  });
  const subject = (letter.email_subject ?? "").trim() || defaults.subject;
  const body    = letter.email_body ?? defaults.body;

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
}
