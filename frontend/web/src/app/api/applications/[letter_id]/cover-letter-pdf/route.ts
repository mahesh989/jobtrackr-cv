/**
 * GET /api/applications/[letter_id]/cover-letter-pdf
 *
 * Returns the cover letter PDF as a downloadable attachment. Lazy-generates
 * and uploads to Storage on first request via ensureCoverLetterPdf.
 *
 * Used by the ApplicationCard "Download letter" button — replaces the old
 * client-side jsPDF render so the downloaded PDF matches the one attached
 * to outgoing emails exactly.
 */

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { ensureCoverLetterPdf }       from "@/lib/coverLetterPdfStore";
import { filenameSlug }               from "@/lib/filenameSlug";
import { jsonError, withUser } from "@/lib/api-utils";

export const GET = withUser(async (
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> }, { user }) => {

  const { letter_id } = await params;

  // Look up the company name for a useful filename. We could let
  // ensureCoverLetterPdf return it, but a small extra round-trip keeps the
  // helper's signature focused on PDF production.
  const admin = createAdminClient();
  const { data: letter } = await admin
    .from("cover_letters")
    .select("job_id")
    .eq("id", letter_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!letter) {
    return jsonError("Letter not found", 404);
  }

  const { data: job } = await admin
    .from("jobs")
    .select("company")
    .eq("id", letter.job_id)
    .maybeSingle();
  const companySlug = filenameSlug(job?.company);

  let bytes: Buffer;
  try {
    const ensured = await ensureCoverLetterPdf(letter_id, user.id);
    bytes = ensured.bytes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cover-letter-pdf] generation failed:", msg);
    return jsonError("PDF generation failed", 500);
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type":        "application/pdf",
      // `inline` so the browser previews in a new tab; users can still save
      // from the viewer. The card opens this in target="_blank".
      "Content-Disposition": `inline; filename="CoverLetter_${companySlug}.pdf"`,
      "Content-Length":      bytes.length.toString(),
    },
  });
});
