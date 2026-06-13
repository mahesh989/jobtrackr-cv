/**
 * Lazy generate-and-store helper for cover letter PDFs.
 *
 * ensureCoverLetterPdf(letterId, userId):
 *   - If cover_letters.pdf_storage_path is already set, return it as-is
 *     (idempotent — never re-renders).
 *   - Otherwise: fetch letter + job + user_preferences, assemble the
 *     delivery-ready text, render to PDF via renderCoverLetterPdf, upload
 *     to the cover-letters bucket, update pdf_storage_path, return the path.
 *
 * Failure modes are surfaced as thrown Error — callers should try/catch and
 * decide whether to proceed without the cover letter PDF attachment.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { assembleLetter, type ContactDetails } from "@/lib/coverLetterTemplate";
import { renderCoverLetterPdf } from "@/lib/coverLetterPdf";

const COVER_LETTER_BUCKET = "cover-letters";

export interface EnsuredPdf {
  path:     string;   // {user_id}/{letter_id}.pdf
  bytes:    Buffer;   // the PDF bytes (downloaded or freshly rendered)
}

/**
 * Idempotently produce a cover-letter PDF in Storage and return its path + bytes.
 *
 * Why bytes too? The most common caller (send-email) needs the bytes for the
 * attachment — returning them avoids a second Storage round-trip immediately
 * after upload.
 */
export async function ensureCoverLetterPdf(
  letterId: string,
  userId:   string,
): Promise<EnsuredPdf> {
  const admin = createAdminClient();

  // ── 1. Fetch letter ──────────────────────────────────────────────────────
  const { data: letter, error: lErr } = await admin
    .from("cover_letters")
    .select("id, user_id, job_id, pass_3_final, pdf_storage_path")
    .eq("id", letterId)
    .maybeSingle();

  if (lErr || !letter) {
    throw new Error(`cover_letters lookup failed: ${lErr?.message ?? "not found"}`);
  }
  if (letter.user_id !== userId) {
    throw new Error("Forbidden — letter does not belong to user");
  }

  // ── 2. Short-circuit if already stored ───────────────────────────────────
  if (letter.pdf_storage_path) {
    const { data: existing, error: dErr } = await admin
      .storage
      .from(COVER_LETTER_BUCKET)
      .download(letter.pdf_storage_path);
    if (existing && !dErr) {
      return {
        path:  letter.pdf_storage_path,
        bytes: Buffer.from(await existing.arrayBuffer()),
      };
    }
    // Path was recorded but the object is missing — fall through and regen.
  }

  // ── 3. Fetch job + user_preferences to assemble the letter ──────────────
  // Note: jobs has no direct user_id column — ownership flows through
  // jobs.profile_id → search_profiles.user_id. The letter.user_id check
  // above is the authoritative ownership gate; the cover_letter could only
  // be created against a job in one of the user's own profiles in the first
  // place (enforced by the existing /cover-letter POST route).
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, profile_id, company, location, hiring_manager, company_address")
    .eq("id", letter.job_id)
    .maybeSingle();
  if (jobErr || !job) {
    throw new Error(`job lookup failed: ${jobErr?.message ?? "no row for letter.job_id"}`);
  }

  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", userId)
    .maybeSingle();
  const contactDetails = (prefs?.contact_details as ContactDetails) || {};

  // ── 4. Assemble delivery-ready text ──────────────────────────────────────
  const hiringManager = (job.hiring_manager ?? "").trim() || null;
  const body          = letter.pass_3_final ?? "";

  const templatedText = assembleLetter({
    contactDetails,
    company:         job.company ?? "",
    companyAddress:  job.company_address ?? null,
    companyLocation: job.location ?? null,
    hiringManager,
    body,
  });

  // ── 5. Render PDF ────────────────────────────────────────────────────────
  const bytes = renderCoverLetterPdf(templatedText);

  // ── 6. Upload to Storage ─────────────────────────────────────────────────
  const path = `${userId}/${letterId}.pdf`;
  const { error: upErr } = await admin
    .storage
    .from(COVER_LETTER_BUCKET)
    .upload(path, bytes, {
      contentType: "application/pdf",
      upsert:      true,
    });
  if (upErr) {
    // Best-effort retry via update() — same fallback pattern as orchestrator's
    // tailored CV upload.
    const { error: updErr } = await admin
      .storage
      .from(COVER_LETTER_BUCKET)
      .update(path, bytes, { contentType: "application/pdf" });
    if (updErr) {
      throw new Error(`Storage upload failed: ${upErr.message} (and update fallback: ${updErr.message})`);
    }
  }

  // ── 7. Record the path on the letter row ────────────────────────────────
  const { error: patchErr } = await admin
    .from("cover_letters")
    .update({ pdf_storage_path: path })
    .eq("id", letterId);
  if (patchErr) {
    // Not fatal — the PDF is uploaded; we just don't have the pointer recorded.
    // Future calls will see pdf_storage_path NULL and re-render. Log & continue.
    console.warn("[ensureCoverLetterPdf] pdf_storage_path patch failed:", patchErr.message);
  }

  return { path, bytes };
}
