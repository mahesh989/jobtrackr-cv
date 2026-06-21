/**
 * /api/cv/create
 *
 * POST — create a blank "built in app" CV the user fills in by hand via the
 *        review form (create mode). Unlike /api/cv (upload), there is no file
 *        and no AI: we INSERT a cv_versions row with an empty structured_cv and
 *        render its (short) canonical text so the row is coherent from the start.
 *
 * The row is marked with a sentinel `pdf_storage_path` of `built://{cv_id}` —
 * there is no Storage object. This sentinel is the single signal the rest of the
 * app uses to recognise a from-scratch CV (review page create mode, library
 * badge, cv_text sync in the structured PATCH, ensureActive / delete guards).
 * No migration and no new status value are introduced.
 *
 * The blank doc carries `_version: STRUCTURED_CV_VERSION` so the review page's
 * silent re-structurize never fires — there is no source text to re-parse and
 * doing so would clobber the user's manual edits.
 */

import { NextResponse }       from "next/server";
import { createClient }       from "@/lib/supabase/server";
import { createAdminClient }  from "@/lib/supabase/admin";
import {
  renderCanonicalCv,
  CvBackendError,
  STRUCTURED_CV_VERSION,
  type StructuredCv,
} from "@/lib/cvBackend";

export const runtime     = "nodejs";
export const maxDuration = 15;

function blankStructuredCv(): StructuredCv {
  return {
    summary:        "",
    experience:     [],
    education:      [],
    awards:         [],
    languages:      [],
    certifications: [],
    skills:         { technical: [], soft_skills: [], domain_knowledge: [] },
    references:     [],
    gaps:           [],
    _version:       STRUCTURED_CV_VERSION,
  };
}

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cv_id           = crypto.randomUUID();
  const storage_path    = `built://${cv_id}`;
  const structured_cv   = blankStructuredCv();

  // Render the (near-empty) canonical text. Pure function, no AI — but if the
  // renderer is unreachable we still want the row to exist with valid text, so
  // fall back to a minimal placeholder rather than failing the create.
  let normalized_cv_text = "";
  try {
    const r = await renderCanonicalCv({ structured_cv });
    normalized_cv_text = r.normalized_cv_text;
  } catch (err) {
    const detail = err instanceof CvBackendError
      ? `cv-backend render failed (${err.status})`
      : String(err);
    console.warn("[/api/cv/create] render failed (using placeholder):", detail);
  }
  // cv_text is NOT NULL — keep it in sync with the rendered text from the start.
  // (The structured PATCH keeps these two in lockstep on every save.)
  const cv_text = normalized_cv_text.trim() || "(CV built in JobTrackr — add your details)";

  const admin = createAdminClient();

  // INSERT. The structured_cv / normalized_cv_text columns ship in migrations
  // 058 + 059; on a pre-migration deploy fall back to the legacy shape so the
  // create still succeeds (mirrors /api/cv POST).
  const baseRow = {
    id:                 cv_id,
    user_id:            user.id,
    label:              "My CV",
    pdf_storage_path:   storage_path,
    cv_text,
    is_active:          false,
    categorised_skills: structured_cv.skills,
  };
  const withStructured = {
    ...baseRow,
    structured_cv,
    structured_cv_status: "parsed",
    normalized_cv_text,
  };

  const first = await admin
    .from("cv_versions")
    .insert(withStructured)
    .select("id")
    .single();

  let row = first.data as { id: string } | null;
  let insertErr = first.error ? { message: first.error.message } : null;

  if (first.error && /structured_cv|normalized_cv_text|column/i.test(first.error.message)) {
    console.warn("[/api/cv/create] structured columns missing — legacy insert (apply migrations 058+059):", first.error.message);
    const fallback = await admin
      .from("cv_versions")
      .insert(baseRow)
      .select("id")
      .single();
    row = fallback.data as { id: string } | null;
    insertErr = fallback.error ? { message: fallback.error.message } : null;
  }

  if (insertErr || !row) {
    console.error("[/api/cv/create] insert failed:", insertErr?.message);
    return NextResponse.json({ error: "Failed to create CV" }, { status: 500 });
  }

  return NextResponse.json({
    id:          row.id,
    redirect_to: `/dashboard/cv/${row.id}/review`,
  });
}
