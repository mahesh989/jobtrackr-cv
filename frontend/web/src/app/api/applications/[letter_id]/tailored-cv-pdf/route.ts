/**
 * GET /api/applications/[letter_id]/tailored-cv-pdf
 *
 * Streams the server-rendered tailored CV PDF (the same one cv-backend writes
 * at analysis time and attaches to outgoing emails) inline, so the browser
 * previews it in a new tab. Mirrors the cover-letter-pdf route so the
 * Applications "Tailored CV" action opens instantly via a plain
 * <a target="_blank"> — no client-side html2canvas render, no popup window.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";

const TAILORED_CV_BUCKET = "tailored-cvs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ letter_id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { letter_id } = await params;
  const admin = createAdminClient();

  // Ownership: the letter must belong to the caller. We only need its job_id
  // to locate the tailored PDF (same resolution the send-email route uses).
  const { data: letter } = await admin
    .from("cover_letters")
    .select("job_id, user_id")
    .eq("id", letter_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!letter) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Latest non-stale run for this job that actually has a rendered PDF.
  const { data: run } = await admin
    .from("analysis_runs")
    .select("tailored_pdf_storage_path")
    .eq("job_id", letter.job_id)
    .eq("user_id", user.id)
    .eq("is_stale", false)
    .not("tailored_pdf_storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run?.tailored_pdf_storage_path) {
    return NextResponse.json({ error: "Tailored CV PDF not available" }, { status: 404 });
  }

  const { data: pdfData, error: dlErr } = await admin
    .storage
    .from(TAILORED_CV_BUCKET)
    .download(run.tailored_pdf_storage_path);
  if (dlErr || !pdfData) {
    console.error("[tailored-cv-pdf] download failed:", dlErr?.message);
    return NextResponse.json({ error: "Could not load the tailored CV PDF" }, { status: 500 });
  }
  const bytes = Buffer.from(await pdfData.arrayBuffer());

  // Company name for a useful filename.
  const { data: job } = await admin
    .from("jobs")
    .select("company")
    .eq("id", letter.job_id)
    .maybeSingle();
  const companySlug = (job?.company ?? "company").replace(/[^a-zA-Z0-9]/g, "_");

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so the browser previews in the new tab; the card opens this
      // via target="_blank".
      "Content-Disposition": `inline; filename="TailoredCV_${companySlug}.pdf"`,
      "Content-Length":      bytes.length.toString(),
    },
  });
}
