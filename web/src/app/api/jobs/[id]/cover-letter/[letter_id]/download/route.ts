/**
 * GET /api/jobs/[id]/cover-letter/[letter_id]/download
 *
 * Assemble the delivery-ready cover letter and return it for client-side
 * PDF rendering. The client (CoverLetterPanel) generates the PDF using
 * jspdf and initiates the browser download.
 *
 * Query params:
 *   ?hiring_manager_override=... — use this name instead of jobs.hiring_manager
 *   ?edited_body=... — use this body text instead of pass_3_final (optional)
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { assembleLetter, type ContactDetails } from "@/lib/coverLetterTemplate";

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

  const admin = createAdminClient();

  const { data: letter } = await admin
    .from("cover_letters")
    .select("id, pass_3_final, job_id")
    .eq("id", letterId)
    .maybeSingle();
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 });

  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, hiring_manager")
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
    company:       job.company,
    jobTitle:      job.title,
    hiringManager,
    body,
  });

  return NextResponse.json({
    templated_text: templatedText,
    hiring_manager: hiringManager ?? "Hiring Manager",
    company:        job.company,
    user_name:      contactDetails.name || "",
  });
}
