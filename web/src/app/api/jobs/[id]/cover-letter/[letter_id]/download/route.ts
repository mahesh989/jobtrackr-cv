/**
 * GET /api/jobs/[id]/cover-letter/[letter_id]/download
 *
 * Assemble the delivery-ready cover letter. By default returns JSON
 * containing the assembled text (legacy contract — kept for any callers
 * still rendering client-side). Pass ?format=pdf to receive the PDF bytes
 * directly — same server-side renderer used by the Applications outbox
 * (Phase G), so this is now the single canonical PDF path.
 *
 * Query params:
 *   ?format=pdf — return application/pdf bytes (Content-Disposition: attachment)
 *                 otherwise return JSON {templated_text, ...}
 *   ?hiring_manager_override=... — use this name instead of jobs.hiring_manager
 *                                  (preview-only — does not persist to the job)
 *   ?edited_body=... — use this body text instead of pass_3_final
 *                      (preview-only — does not persist to cover_letters)
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { createClient }        from "@/lib/supabase/server";
import { assembleLetter, type ContactDetails } from "@/lib/coverLetterTemplate";
import { renderCoverLetterPdf } from "@/lib/coverLetterPdf";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; letter_id: string }> },
) {
  const { id: jobId, letter_id: letterId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hireMgrOverride = req.nextUrl.searchParams.get("hiring_manager_override");
  const editedBody      = req.nextUrl.searchParams.get("edited_body");
  const format          = req.nextUrl.searchParams.get("format");   // "pdf" or null

  const admin = createAdminClient();

  const { data: letter } = await admin
    .from("cover_letters")
    .select("id, pass_3_final, job_id")
    .eq("id", letterId)
    .maybeSingle();
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 });

  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, company, location, hiring_manager, company_address")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Ownership: job → profile → user. Authenticated but not owner = 403.
  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();
  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  const contactDetails = (prefs?.contact_details as ContactDetails) || {};

  // Real name only; null triggers the "Dear Hiring Manager," fallback inside
  // assembleLetter and suppresses the duplicate name line in the employer block.
  const hiringManager = (hireMgrOverride?.trim() || job.hiring_manager || "").trim() || null;
  const body          = editedBody || letter.pass_3_final || "";

  const templatedText = assembleLetter({
    contactDetails,
    company:         job.company,
    companyAddress:  job.company_address ?? null,
    companyLocation: job.location ?? null,
    hiringManager,
    body,
  });

  // ── format=pdf: render server-side and stream PDF bytes ──────────────────
  if (format === "pdf") {
    const bytes  = renderCoverLetterPdf(templatedText);
    const slug   = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const initials = (contactDetails.name ?? "")
      .split(/\s+/)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 3);
    const companySlug = slug(job.company ?? "company");
    const filename    = initials
      ? `${companySlug}_${initials}_cover_letter.pdf`
      : `${companySlug}_cover_letter.pdf`;

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type":        "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length":      bytes.length.toString(),
      },
    });
  }

  // ── Default: legacy JSON response with the assembled text ────────────────
  return NextResponse.json({
    templated_text: templatedText,
    hiring_manager: hiringManager ?? "Hiring Manager",
    company:        job.company,
    user_name:      contactDetails.name || "",
  });
}
