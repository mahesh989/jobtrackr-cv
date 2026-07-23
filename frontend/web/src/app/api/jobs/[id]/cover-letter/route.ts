/**
 * POST /api/jobs/[id]/cover-letter
 *
 * Trigger single-call cover letter generation for a job. Returns 200
 * immediately with { letter_id } — the cv-backend pipeline runs
 * asynchronously and writes progress to cover_letters via Realtime.
 *
 * Thin shell: auth (withUser) + param resolution only. The full
 * orchestration lives in lib/coverLetter/start.ts.
 */

import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-utils";
import { startCoverLetter } from "@/lib/coverLetter/start";

export const runtime     = "nodejs";
export const maxDuration = 60;  // generateOpeningVariants is synchronous (~5-15 s); allow headroom

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id: jobId } = await params;
  return startCoverLetter(req, jobId, user);
});
