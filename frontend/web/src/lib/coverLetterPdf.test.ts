/**
 * Regression test: the sign-off block ("Yours sincerely," + blank line +
 * name — see coverLetterTemplate.ts's assembleLetter()) used to be able to
 * split across a page break. The per-line loop only checked "does THIS
 * line fit", so a letter that ran right up to the bottom of a page could
 * fit "Yours sincerely," but push the blank line + name onto a page of
 * their own — a name orphaned alone on the next page.
 *
 * jsPDF (uncompressed, standard Helvetica font — no embedded font
 * streams) writes one `stream ... endstream` block per page, in page
 * order, each containing that page's `(text) Tj` draw operators. Extracting
 * those blocks lets this test verify which physical page a given line of
 * text landed on without needing a PDF-parsing dependency.
 */
import { describe, it, expect } from "vitest";
import { renderCoverLetterPdf } from "./coverLetterPdf";

function pageContentBlocks(pdfBuffer: Buffer): string[] {
  const str = pdfBuffer.toString("latin1");
  const blocks: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) blocks.push(m[1]);
  return blocks;
}

function pageIndexOf(blocks: string[], literalText: string): number {
  // jsPDF escapes literal-string special chars (\, (, )) with a backslash;
  // none of our test strings use them, so a plain substring match is safe.
  return blocks.findIndex((b) => b.includes(`(${literalText}) Tj`));
}

/** Build a letter whose body is exactly `n` short filler lines — enough to
 * sweep across several page boundaries and land on the exact byte where
 * "Yours sincerely," fits at the bottom of a page but the block after it
 * doesn't. */
function letterWithBodyLines(n: number): string {
  const bodyLines = Array.from(
    { length: n },
    (_, i) => `Line ${i + 1} filler text to advance the cursor down the page steadily.`,
  );
  return [
    "Rashmi Poudel",
    "",
    bodyLines.join("\n"),
    "",
    "Yours sincerely,",
    "",
    "Rashmi Poudel",
  ].join("\n");
}

describe("renderCoverLetterPdf — sign-off block must never split across a page", () => {
  it("keeps 'Yours sincerely,' and the name on the same page across a sweep of body lengths", () => {
    // A wide sweep so at least one length lands in the narrow window where
    // the old per-line-only check used to fail (confirmed via manual sweep
    // during development: n=45, 93, 94, 141, 142 reproduced the split with
    // the pre-fix logic).
    for (let n = 1; n <= 150; n++) {
      const pdf = renderCoverLetterPdf(letterWithBodyLines(n));
      const blocks = pageContentBlocks(pdf);
      const signOffPage = pageIndexOf(blocks, "Yours sincerely,");
      // The header name and the sign-off name are identical text, so take
      // the LAST block containing it (the sign-off one), not the first.
      const namePage = blocks.reduce(
        (acc, b, i) => (b.includes("(Rashmi Poudel) Tj") ? i : acc),
        -1,
      );

      expect(signOffPage, `n=${n}: "Yours sincerely," not found`).toBeGreaterThanOrEqual(0);
      expect(namePage, `n=${n}: name not found`).toBeGreaterThanOrEqual(0);
      expect(namePage, `n=${n}: sign-off split across pages (signOff=${signOffPage}, name=${namePage})`).toBe(signOffPage);
    }
  });

  it("still wraps normally for a short one-page letter (no spurious page break)", () => {
    const pdf = renderCoverLetterPdf(letterWithBodyLines(2));
    const blocks = pageContentBlocks(pdf);
    expect(blocks).toHaveLength(1);
  });
});
