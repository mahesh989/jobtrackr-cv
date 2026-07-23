/**
 * POST /api/applications/[letter_id]/send-email
 *
 * Sends the cover letter to the job's contact_email with the tailored CV
 * + letter PDFs attached, then stamps sent state on letter + job.
 *
 * Thin shell: auth (withUser) + param resolution only. The full dispatch
 * pipeline lives in lib/email/sendApplication.ts.
 */

import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-utils";
import { sendApplicationEmail } from "@/lib/email/sendApplication";

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
  { user },
) => {
  const { letter_id } = await params;
  return sendApplicationEmail(req, letter_id, user);
});
