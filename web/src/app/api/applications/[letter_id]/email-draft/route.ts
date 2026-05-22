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
}

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
    .select("id, user_id, job_id, email_sent_at")
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
  if (!job.contact_email) {
    return NextResponse.json(
      { error: "No contact email on the job — add one in the pool first" },
      { status: 422 },
    );
  }

  // 3. User name from preferences (best-effort for the signoff)
  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  const userName = ((prefs?.contact_details as ContactDetails | null)?.name ?? "").trim() || null;

  // 4. Detect whether a tailored CV PDF exists for the attachments list
  const { data: run } = await admin
    .from("analysis_runs")
    .select("tailored_pdf_storage_path")
    .eq("job_id", letter.job_id)
    .eq("user_id", user.id)
    .eq("is_stale", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const hasTailoredCv = !!run?.tailored_pdf_storage_path;

  // 5. Build the default draft
  const { subject, body } = buildDefaultEmailDraft({
    jobTitle:      job.title,
    company:       job.company,
    hiringManager: job.hiring_manager,
    userName,
  });

  const toDisplay = job.hiring_manager
    ? `${job.hiring_manager} <${job.contact_email}>`
    : job.contact_email;

  const companySlug = (job.company ?? "company").replace(/[^a-zA-Z0-9]/g, "_");
  const attachments: string[] = [`CoverLetter_${companySlug}.pdf`];
  if (hasTailoredCv) attachments.push(`TailoredCV_${companySlug}.pdf`);

  return NextResponse.json({
    to:            toDisplay,
    to_email:      job.contact_email,
    hiring_manager: job.hiring_manager,
    job_title:     job.title,
    job_company:   job.company,
    user_name:     userName,
    subject,
    body,
    attachments,
    has_tailored_cv: hasTailoredCv,
  });
}
