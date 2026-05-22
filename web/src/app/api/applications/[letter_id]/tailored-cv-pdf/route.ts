/**
 * GET /api/applications/[letter_id]/tailored-cv-pdf
 *
 * Returns the tailored CV PDF for the letter's job, served inline so the
 * browser previews it in a new tab. Mirrors cover-letter-pdf so the
 * ApplicationCard can offer side-by-side preview of both PDFs before send.
 *
 * Ownership: cover_letters.user_id is the authoritative gate. The PDF path
 * lives on analysis_runs (which also has user_id since migration 011).
 * jobs has no user_id — do NOT filter jobs by user.id (see commit adc078b).
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

  // 1. Letter → job_id (ownership-gated by user_id)
  const { data: letter } = await admin
    .from("cover_letters")
    .select("job_id")
    .eq("id", letter_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!letter) {
    return NextResponse.json({ error: "Letter not found" }, { status: 404 });
  }

  // 2. Latest non-stale analysis_run for this job (own user only)
  const { data: run } = await admin
    .from("analysis_runs")
    .select("tailored_pdf_storage_path")
    .eq("job_id", letter.job_id)
    .eq("user_id", user.id)
    .eq("is_stale", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run?.tailored_pdf_storage_path) {
    return NextResponse.json(
      { error: "No tailored CV PDF available for this job yet" },
      { status: 404 },
    );
  }

  // 3. Company name for filename (best-effort)
  const { data: job } = await admin
    .from("jobs")
    .select("company")
    .eq("id", letter.job_id)
    .maybeSingle();
  const companySlug = (job?.company ?? "company").replace(/[^a-zA-Z0-9]/g, "_");

  // 4. Stream the PDF
  const { data: pdfData, error: dlErr } = await admin
    .storage
    .from(TAILORED_CV_BUCKET)
    .download(run.tailored_pdf_storage_path);

  if (dlErr || !pdfData) {
    console.error("[tailored-cv-pdf] download failed:", dlErr);
    return NextResponse.json({ error: "PDF download failed" }, { status: 500 });
  }

  const bytes = Buffer.from(await pdfData.arrayBuffer());

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type":        "application/pdf",
      "Content-Disposition": `inline; filename="TailoredCV_${companySlug}.pdf"`,
      "Content-Length":      bytes.length.toString(),
    },
  });
}
