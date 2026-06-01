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
  // Sanitize input text. jsPDF's standard non-embedded fonts (like Helvetica)
  // only support standard ASCII/WinAnsi characters. Unicode characters like
  // the non-breaking hyphen (\u2011) are unsupported, causing jsPDF to drop
  // letters and spacing calculations to break (leading to extreme letter-spacing).
  const sanitizedText = templatedText
    .replace(/\u2011/g, "-")  // non-breaking hyphen -> standard hyphen
    .replace(/\u00a0/g, " "); // non-breaking space -> standard space

  // Split on hard newlines first so blank source lines become explicit
  // paragraph gaps rather than collapsing into uniform line spacing.
  const rawLines = sanitizedText.split("\n");
  for (const raw of rawLines) {
    if (raw.trim() === "") {
      yPos += paragraphGap;
      continue;
    }
    // Split with a 10pt safety buffer — jsPDF's character-width tables are
    // slightly optimistic for some glyph combinations, which causes the last
    // word of an "exact-fit" line to overflow the right margin by a few pt.
    // Wrapping 10pt early prevents this without visibly narrowing the column.
    const wrapped: string[] = doc.splitTextToSize(raw, textWidth - 10);
    for (const wl of wrapped) {
      if (yPos + lineHeight > pageHeight - margin) {
        doc.addPage();
        yPos = margin;
      }
      // Strip leading whitespace from the wrapped line AND pass an explicit
      // align: "left". Two safety belts against jsPDF's letter-spacing
      // glitch where a wrapped line that begins with whitespace (typically
      // a paragraph-internal continuation, e.g. " Sanctuary Care…" after
      // a hard wrap) gets rendered with full-width inter-character spacing
      // as if "justify" alignment had been requested. align defaults to
      // "left" in current jsPDF but some font/glyph combos still trip the
      // bug. Passing it explicitly forces the safe path on every line.
      doc.text(wl.replace(/^\s+/, ""), margin, yPos, { align: "left" });
      yPos += lineHeight;
    }
  }

  // doc.output("arraybuffer") returns an ArrayBuffer (or ArrayBufferLike in
  // some jsPDF versions). Wrapping in Uint8Array first keeps Buffer.from
  // type-safe across versions.
  return Buffer.from(new Uint8Array(doc.output("arraybuffer")));
}
