/**
 * /api/cv/[id]/structured
 *
 * GET   — fetch the current structured_cv for the review form (must be owned).
 * PATCH — accept an edited structured_cv from the autosave loop, re-render
 *         canonical markdown via cv-backend (single source of truth for the
 *         renderer), and persist both `structured_cv` and `normalized_cv_text`.
 *         Sets status='edited' on first edit, 'verified' when body.verified=true.
 *
 * The pipeline reads `normalized_cv_text` when present (Phase 2-7), so every
 * save here directly shapes what analysis sees next.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { renderCanonicalCv, CvBackendError, type StructuredCv } from "@/lib/cv/backend";
import { withUser }                  from "@/lib/api-utils";

export const runtime     = "nodejs";
export const maxDuration = 15;

// ── GET ──────────────────────────────────────────────────────────────────────

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id } = await params;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cv_versions")
    .select("id, label, structured_cv, structured_cv_status, normalized_cv_text, cv_text")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
});

// ── PATCH ────────────────────────────────────────────────────────────────────

export const PATCH = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id } = await params;

  let body: { structured_cv?: unknown; verified?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!body.structured_cv || typeof body.structured_cv !== "object") {
    return NextResponse.json({ error: "structured_cv is required" }, { status: 400 });
  }
  const structuredCv = body.structured_cv as StructuredCv;

  const admin = createAdminClient();

  // Ownership check (cheap — single row by id).
  const { data: owned } = await admin
    .from("cv_versions")
    .select("id, structured_cv_status, pdf_storage_path")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Re-render canonical text. This is the moment the user's edits flow into
  // what the pipeline reads next — if it fails, we MUST NOT persist a stale
  // normalized text and lie about it, so we reject the save.
  let normalizedCvText = "";
  try {
    const r = await renderCanonicalCv({ structured_cv: structuredCv });
    normalizedCvText = r.normalized_cv_text;
  } catch (err) {
    const detail = err instanceof CvBackendError
      ? `cv-backend render failed (${err.status})`
      : "cv-backend render failed";
    console.error("[/api/cv/:id/structured PATCH] render failed:", err);
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  // Persist. Status escalates parsed → edited → verified but never goes back.
  const currentStatus = (owned as { structured_cv_status: string | null }).structured_cv_status;
  const newStatus = body.verified === true
    ? "verified"
    : (currentStatus === "verified" ? "verified" : "edited");

  // Keep categorised_skills (a denormalised column read by the CV-library
  // listing and the analysis pipeline) in lockstep with structured_cv.skills
  // — the form is the editor of record for both.
  const skills = structuredCv.skills ?? { technical: [], soft_skills: [], domain_knowledge: [] };

  // For a "built in app" CV there is no original extraction — cv_text is just a
  // mirror of the rendered canonical text. Keep them in lockstep so the analyze
  // fallback (cv_text) is always valid. Uploaded CVs keep their original cv_text
  // untouched.
  const isBuilt = String((owned as { pdf_storage_path?: string | null }).pdf_storage_path ?? "").startsWith("built://");
  const updatePayload: Record<string, unknown> = {
    structured_cv:        structuredCv,
    structured_cv_status: newStatus,
    normalized_cv_text:   normalizedCvText,
    categorised_skills:   skills,
  };
  if (isBuilt && normalizedCvText.trim()) updatePayload.cv_text = normalizedCvText;

  const { error: updateErr } = await admin
    .from("cv_versions")
    .update(updatePayload)
    .eq("id", id);

  if (updateErr) {
    console.error("[/api/cv/:id/structured PATCH] update failed:", updateErr.message);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }

  // No profile-store referee seed here — referees are single-sourced from
  // this CV's structured_cv.references at analyze time (see the splice in
  // /api/jobs/[id]/analyze and triggerAutoAnalyze.ts). The profile store only
  // keeps the display `mode` now.

  return NextResponse.json({
    ok:                   true,
    structured_cv_status: newStatus,
    normalized_cv_text:   normalizedCvText,
  });
});
