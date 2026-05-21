/**
 * Server-side cover letter PDF renderer.
 *
 * Renders the assembled letter text to a PDF buffer using jsPDF in Node.
 * Layout mirrors the client-side render in CoverLetterPanel.handleDownloadPDF
 * exactly (A4 portrait, 0.8in margins, 11pt Helvetica, 1.35 line height) so
 * the stored PDF visually matches what users used to download.
 *
 * Server-side use cases:
 *   - Generate-and-store after a letter completes (Phase G persistence)
 *   - Attach to outgoing emails (Phase F send-email + Phase G attachment)
 *   - Re-download from the Applications outbox
 *
 * Only call from server-side code (Route Handlers, Server Actions).
 */

import { jsPDF } from "jspdf";

/**
 * Render the templated (assembled) cover letter text to a PDF Buffer.
 * `templatedText` is the output of assembleLetter() — already includes the
 * contact block, date, employer block, salutation, body, and sign-off.
 */
export function renderCoverLetterPdf(templatedText: string): Buffer {
  // A4 portrait, 0.8in margins all sides, 11pt Helvetica.
  // Matches CoverLetterPanel.handleDownloadPDF (web/src/components/cv/...).
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageWidth   = doc.internal.pageSize.getWidth();
  const pageHeight  = doc.internal.pageSize.getHeight();
  const margin      = 57.6;                  // 0.8in
  const textWidth   = pageWidth - 2 * margin;
  const fontSize    = 11;
  const lineHeight  = fontSize * 1.35;       // explicit; jsPDF default 1.15 is too tight
  const paragraphGap = lineHeight * 0.6;     // extra space for blank source lines

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(fontSize);

  let yPos = margin;
  // Split on hard newlines first so blank source lines become explicit
  // paragraph gaps rather than collapsing into uniform line spacing.
  const rawLines = templatedText.split("\n");
  for (const raw of rawLines) {
    if (raw.trim() === "") {
      yPos += paragraphGap;
      continue;
    }
    const wrapped: string[] = doc.splitTextToSize(raw, textWidth);
    for (const wl of wrapped) {
      if (yPos + lineHeight > pageHeight - margin) {
        doc.addPage();
        yPos = margin;
      }
      doc.text(wl, margin, yPos);
      yPos += lineHeight;
    }
  }

  // doc.output("arraybuffer") returns an ArrayBuffer (or ArrayBufferLike in
  // some jsPDF versions). Wrapping in Uint8Array first keeps Buffer.from
  // type-safe across versions.
  return Buffer.from(new Uint8Array(doc.output("arraybuffer")));
}
