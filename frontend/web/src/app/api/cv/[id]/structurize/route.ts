/**
 * POST /api/cv/[id]/structurize
 *
 * On-demand structurization for an EXISTING CV. Lets the user run the
 * review form on CVs that were uploaded before the structurization feature
 * shipped (i.e. structured_cv is NULL), and is also called silently by the
 * review page when the stored `_version` is below STRUCTURED_CV_VERSION.
 *
 * Returns { ok: true } on success — the caller then routes to
 * /cv/{id}/review.
 */

import { NextRequest, NextResponse } from "next/server";
import { structurizeAndPersist }     from "@/lib/cv/structurizeAndCategorise";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { PROVIDER_ORDER }           from "@/lib/ai/models";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 60;

type Provider = (typeof PROVIDER_ORDER)[number];

export const POST = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id } = await params;


  // Rate limit: 2 AI calls (structurize + categorise), also silently
  // auto-fired by the review page on a stale stored version.
  const rl = await rateLimit(`cv-structurize:${user.id}`, 8, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("provider");
  const preferred: Provider | null = (raw && (PROVIDER_ORDER as readonly string[]).includes(raw))
    ? (raw as Provider)
    : null;

  const r = await structurizeAndPersist(user.id, id, preferred);
  if (r.ok) return NextResponse.json({ ok: true });

  switch (r.error.kind) {
    case "not_found":
      return jsonError("CV not found", 404);
    case "empty_cv_text":
      return jsonError("CV has no extractable text — re-upload the file.", 422);
    case "no_ai_key":
      return jsonError("No AI key connected. Add one in Settings → Integrations.", 422);
    case "decrypt_failed":
      return jsonError("Could not decrypt your AI key — re-connect it in Integrations.", 500);
    case "ai_failed":
      console.error("[/api/cv/:id/structurize] AI failed:", r.error.message);
      return jsonError("AI structurization failed", 502);
    case "db_failed":
      // Most likely cause: migrations 058+059 not applied yet.
      console.error("[/api/cv/:id/structurize] update failed:", r.error.message);
      return jsonError("Save failed — apply migrations 058 and 059 in Supabase first.", 500);
  }
});
