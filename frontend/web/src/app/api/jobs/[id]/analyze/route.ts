/**
 * POST /api/jobs/[id]/analyze
 *
 * Kick off the CV-tailoring analysis pipeline for a job. Returns 202-style
 * { run_id } immediately; cv-backend streams step progress via Realtime.
 *
 * Thin shell: auth (withUser) + param resolution only. The full
 * orchestration lives in lib/analyze/start.ts.
 */

import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-utils";
import { analyzeJob } from "@/lib/analyze/start";

export const runtime     = "nodejs";
export const maxDuration = 30;

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id: jobId } = await params;
  return analyzeJob(req, jobId, user);
});
