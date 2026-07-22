/**
 * /api/applications/[letter_id]/tailored-cv-pdf
 *
 * Serves the tailored CV as an INLINE PDF so the Applications "Tailored CV"
 * button can open it in a new tab exactly like the cover-letter button — a
 * plain <a target="_blank">, no popup, no download fallback.
 *
 * Why the bytes are uploaded by the client instead of rendered here:
 * the correct tailored-CV render is a client-side html2canvas + jsPDF pipeline
 * (see renderTailoredCvBlob in src/lib/cvPdfRender.tsx). It can't run in a Node
 * route, and the server ReportLab PDF looks different. So the client renders
 * the exact same bytes it would Download, PUTs them here once, and this route
 * caches + streams them. The served PDF is therefore byte-identical to the
 * analysis-page Download.
 *
 *   PUT  — client uploads the freshly rendered PDF (idempotent upsert).
 *   HEAD — cheap existence check so the client can skip re-rendering when the
 *          PDF is already cached (common after the first view / on reload).
 *   GET  — streams the cached PDF inline.
 *
 * The cache lives in the existing `tailored-cvs` bucket at
 * `{user_id}/{letter_id}.{version}.client.pdf` — deterministic, so no DB
 * pointer is needed (mirrors the cover-letter store's regen-on-missing
 * behaviour).
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { filenameSlug }              from "@/lib/filenameSlug";
import { withUser } from "@/lib/api-utils";

const TAILORED_CV_BUCKET = "tailored-cvs";

// Bump whenever the tailored-CV renderer changes materially
// (cvPdfRender.tsx / cvMarkdownHelpers.ts) — this invalidates all cached PDFs
// and forces a one-time client re-render.
const CV_PDF_RENDER_VERSION = "v2";

// Single source of truth for the cached object's file name / key so
// HEAD / GET / PUT can never diverge.
const pdfFileName = (letterId: string) =>
  `${letterId}.${CV_PDF_RENDER_VERSION}.client.pdf`;
const pdfKey = (userId: string, letterId: string) =>
  `${userId}/${pdfFileName(letterId)}`;

/**
 * Confirm the cover letter (and therefore its tailored CV) belongs to the
 * signed-in user. Returns the letter row (with job_id) or null. This is the
 * same ownership gate the cover-letter-pdf route uses.
 */
async function authLetter(
  admin: ReturnType<typeof createAdminClient>,
  letterId: string,
  userId: string,
) {
  const { data } = await admin
    .from("cover_letters")
    .select("id, job_id")
    .eq("id", letterId)
    .eq("user_id", userId)
    .maybeSingle();
  return data as { id: string; job_id: string } | null;
}

/** HEAD — 200 if the cached PDF exists, 404 otherwise. No body. */
export const HEAD = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> }, { user }) => {

  const { letter_id } = await params;
  const admin = createAdminClient();
  const letter = await authLetter(admin, letter_id, user.id);
  if (!letter) return new NextResponse(null, { status: 404 });

  const { data: list } = await admin
    .storage
    .from(TAILORED_CV_BUCKET)
    .list(user.id, { search: pdfFileName(letter_id), limit: 1 });
  const exists = !!list?.some((f) => f.name === pdfFileName(letter_id));

  return new NextResponse(null, { status: exists ? 200 : 404 });
});

/** PUT — cache the client-rendered PDF bytes. */
export const PUT = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
  { user },
) => {

  const { letter_id } = await params;
  const admin = createAdminClient();
  const letter = await authLetter(admin, letter_id, user.id);
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 });

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }
  // %PDF magic — reject anything that isn't a PDF so a bad client can't poison
  // the cache with arbitrary content served inline.
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return NextResponse.json({ error: "Body is not a PDF" }, { status: 400 });
  }

  const key = pdfKey(user.id, letter_id);
  const { error: upErr } = await admin
    .storage
    .from(TAILORED_CV_BUCKET)
    .upload(key, bytes, { contentType: "application/pdf", upsert: true });
  if (upErr) {
    // Same best-effort fallback the cover-letter store uses.
    const { error: updErr } = await admin
      .storage
      .from(TAILORED_CV_BUCKET)
      .update(key, bytes, { contentType: "application/pdf" });
    if (updErr) {
      console.error("[tailored-cv-pdf] upload failed:", upErr.message, "|", updErr.message);
      return NextResponse.json({ error: "Storage upload failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
});

/** GET — stream the cached PDF inline. */
export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
  { user },
) => {

  const { letter_id } = await params;
  const admin = createAdminClient();
  const letter = await authLetter(admin, letter_id, user.id);
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 });

  const { data: file, error: dlErr } = await admin
    .storage
    .from(TAILORED_CV_BUCKET)
    .download(pdfKey(user.id, letter_id));
  if (dlErr || !file) {
    // Not generated yet — the client PUTs it before enabling the link, so this
    // only happens if the link is hit directly before the render completes.
    return NextResponse.json({ error: "Tailored CV PDF not generated yet" }, { status: 404 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());

  const { data: job } = await admin
    .from("jobs")
    .select("company")
    .eq("id", letter.job_id)
    .maybeSingle();
  const companySlug = filenameSlug(job?.company as string | undefined);

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type":        "application/pdf",
      // inline so the browser previews it in the new tab (mirrors cover-letter-pdf).
      "Content-Disposition": `inline; filename="TailoredCV_${companySlug}.pdf"`,
      "Content-Length":      bytes.length.toString(),
      "Cache-Control":       "private, max-age=300",
    },
  });
});
