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
import { jsonError, withUser } from "@/lib/api-utils";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { startCoverLetter } from "@/lib/coverLetter/start";

export const runtime     = "nodejs";
export const maxDuration = 60;  // generateOpeningVariants is synchronous (~5-15 s); allow headroom

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  // Rate limit: generation is a real AI call against the single
  // platform-wide provider key (BYOK removed, D20) — every user shares one
  // budget, so an unlimited endpoint is a shared-cost exposure, not just a
  // per-user one.
  const rl = await rateLimit(`cover-letter-generate:${user.id}`, 10, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  const { id: jobId } = await params;
  return startCoverLetter(req, jobId, user);
});
