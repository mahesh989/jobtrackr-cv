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

import { NextResponse } from "next/server";
import { structurizeAndPersist }     from "@/lib/cv/structurizeAndCategorise";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 60;

export const POST = withUser(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id } = await params;


  // Rate limit: 2 AI calls (structurize + categorise), also silently
  // auto-fired by the review page on a stale stored version.
  const rl = await rateLimit(`cv-structurize:${user.id}`, 8, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  // No `?provider=` any more — BYOK is gone (D20) and the provider comes from
  // platform_ai_settings, so there was nothing for the caller to choose.
  const r = await structurizeAndPersist(user.id, id);
  if (r.ok) return NextResponse.json({ ok: true });

  switch (r.error.kind) {
    case "not_found":
      return jsonError("CV not found", 404);
    case "empty_cv_text":
      return jsonError("CV has no extractable text — re-upload the file.", 422);
    case "no_ai_key":
      // Deliberately NOT "add a key in Settings → Integrations": users have
      // not had their own AI key since BYOK was removed, and that screen no
      // longer offers one, so the old copy sent people somewhere they could
      // do nothing. This is an admin-side outage from the user's point of view.
      return jsonError(
        "AI is temporarily unavailable — the platform AI provider isn't configured. Please try again shortly.",
        503,
      );
    case "ai_failed":
      console.error("[/api/cv/:id/structurize] AI failed:", r.error.message);
      return jsonError("AI structurization failed", 502);
    case "db_failed":
      // Most likely cause: migrations 058+059 not applied yet.
      console.error("[/api/cv/:id/structurize] update failed:", r.error.message);
      return jsonError("Save failed — apply migrations 058 and 059 in Supabase first.", 500);
  }
});
