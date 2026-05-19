/**
 * GET /api/jobs/[id]/cover-letter/[letter_id]/template
 *
 * Assemble the delivery-ready cover letter in Australian standard format:
 *   [User contact block]
 *   [Date]
 *   [Employer details]
 *   Dear [Hiring Manager],
 *   RE: [Job Title] at [Company]
 *   [Letter body]
 *   Yours sincerely,
 *   [User name]
 *
 * Query params:
 *   ?hiring_manager_override=... — use this name instead of jobs.hiring_manager
 *
 * Response:
 *   {
 *     templated_text: string,
 *     hiring_manager: string | null
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

interface ContactDetails {
  name?: string;
  address?: string;
  suburb?: string;
  postcode?: string;
  phone?: string;
  email?: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; letter_id: string }> },
) {
  const { id: jobId, letter_id: letterId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check for hiring_manager override query param
  const hireMgrOverride = req.nextUrl.searchParams.get("hiring_manager_override");

  const admin = createAdminClient();

  // Fetch the letter
  const { data: letter } = await admin
    .from("cover_letters")
    .select("id, pass_3_final, job_id")
    .eq("id", letterId)
    .maybeSingle();

  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 });

  // Fetch the job (ownership check + get company, title, hiring_manager)
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id, title, company, hiring_manager")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Verify ownership: job's profile must belong to user
  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();

  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch user contact details
  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();

  const contactDetails = (prefs?.contact_details as ContactDetails) || {};

  // Determine hiring manager name
  const hireMgr = hireMgrOverride || job.hiring_manager || "Hiring Manager";

  // Build contact block (user's details)
  const contactBlock = buildContactBlock(contactDetails);

  // Build letter
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const templatedText = [
    contactBlock,
    "",
    dateStr,
    "",
    job.company,
    hireMgr,
    "Australia",
    "",
    `Dear ${hireMgr},`,
    "",
    `RE: ${job.title} at ${job.company}`,
    "",
    letter.pass_3_final || "",
    "",
    "Yours sincerely,",
    "",
    contactDetails.name || "[Your Name]",
  ].join("\n");

  return NextResponse.json({
    templated_text: templatedText,
    hiring_manager: hireMgr,
  });
}

/**
 * Format user's contact details as a single block.
 * Example output:
 *   Jane Doe
 *   Hurstville NSW 2220
 *   +61 414 032 507
 *   you@example.com
 */
function buildContactBlock(cd: ContactDetails): string {
  const lines: string[] = [];

  if (cd.name) lines.push(cd.name);

  // Build address line: "Street, Suburb Postcode"
  const addressParts: string[] = [];
  if (cd.address) addressParts.push(cd.address);
  if (cd.suburb) {
    const suburbPostcode = cd.postcode ? `${cd.suburb} ${cd.postcode}` : cd.suburb;
    addressParts.push(suburbPostcode);
  } else if (cd.postcode) {
    addressParts.push(cd.postcode);
  }
  if (addressParts.length > 0) lines.push(addressParts.join(" "));

  if (cd.phone) lines.push(cd.phone);
  if (cd.email) lines.push(cd.email);

  return lines.join("\n");
}
