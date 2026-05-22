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
import { createClient }               from "@/lib/supabase/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { ensureCoverLetterPdf }       from "@/lib/coverLetterPdfStore";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }

  const { data: job } = await admin
    .from("jobs")
    .select("company")
    .eq("id", letter.job_id)
    .maybeSingle();
  const companySlug = (job?.company ?? "company").replace(/[^a-zA-Z0-9]/g, "_");

  let bytes: Buffer;
  try {
    const ensured = await ensureCoverLetterPdf(letter_id, user.id);
    bytes = ensured.bytes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cover-letter-pdf] generation failed:", msg);
    return NextResponse.json({ error: `PDF generation failed: ${msg}` }, { status: 500 });
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
}
