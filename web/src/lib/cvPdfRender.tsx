/**
 * Client-side tailored CV PDF render.
 *
 * Shared with TailoredCvCard.handleDownloadPdf — same html2canvas-pro +
 * jsPDF pipeline, same A4/margin constants, same multi-page safe-break
 * algorithm — so the PDF attached to an outgoing email is byte-faithful
 * to the one a user downloads from the analysis page.
 *
 * Unlike TailoredCvCard which works off the visible preview, this helper
 * mounts ReactMarkdown into a hidden off-screen div, lets React commit,
 * captures, then unmounts. The caller only supplies raw markdown +
 * current contact details — no preview toggle required.
 */

"use client";

import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  applyCvSectionLayout,
  boldSkillCategories,
  padPipesAndCleanArtifacts,
  stampContactClient,
  tidyContactLine,
  type ContactDetails,
} from "@/lib/cvMarkdownHelpers";
import { CV_PDF_STYLE } from "@/lib/cvPdfStyle";

interface RenderInput {
  markdown:        string;
  contactDetails:  ContactDetails | null;
}

// ── A4 + margin constants — must match TailoredCvCard.handleDownloadPdf ──
const PAGE_W_PX    = 794;                    // 8.27in @ 96dpi
const MARGIN_PT    = 36;                      // 0.5in
const CONTENT_W_PX = PAGE_W_PX - 2 * 48;      // 698px
const SCAN_BACK_FRAC = 0.18;                  // % of a page to scan back for clean breaks

/**
 * Produce a PDF Blob from raw tailored CV markdown using the same client
 * pipeline as the analysis-page Download PDF button.
 *
 * Browser-only — calls into html2canvas-pro and the DOM. Must NOT be
 * imported by server components or route handlers.
 */
export async function renderTailoredCvBlob({ markdown, contactDetails }: RenderInput): Promise<Blob> {
  // 1. Apply the same formatter chain TailoredCvCard uses
  const formattedMd = padPipesAndCleanArtifacts(
    boldSkillCategories(
      stampContactClient(tidyContactLine(markdown), contactDetails),
    ),
  );

  // 2. Build a hidden off-screen host
  const host = document.createElement("div");
  Object.assign(host.style, {
    position:      "fixed",
    left:          "0",
    top:           "0",
    width:         `${CONTENT_W_PX}px`,
    padding:       "0",
    background:    "#ffffff",
    opacity:       "0",
    pointerEvents: "none",
    zIndex:        "-1",
    color:         "#000000",
    colorScheme:   "light",
  });
  host.innerHTML = `<style>${CV_PDF_STYLE}</style>`;
  const mainEl = document.createElement("main");
  mainEl.className = "cv-root";
  host.appendChild(mainEl);
  document.body.appendChild(host);

  let root: Root | null = null;
  try {
    // 3. Mount ReactMarkdown into the host
    root = createRoot(mainEl);
    await new Promise<void>((resolve) => {
      root!.render(
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#000080", textDecoration: "none" }}
              >
                {children}
              </a>
            ),
          }}
        >
          {formattedMd}
        </ReactMarkdown>
      );
      // Two RAF ticks so React commits + paint settles before DOM mutation.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    // 4. Apply two-column row layout (same as Download PDF path)
    applyCvSectionLayout(mainEl);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // 5. html2canvas + jsPDF — identical to TailoredCvCard
    const [{ default: html2canvas }, { default: JsPDF }] = await Promise.all([
      import("html2canvas-pro"),
      import("jspdf"),
    ]);

    const canvas = await html2canvas(mainEl, {
      scale:           2,
      useCORS:         true,
      backgroundColor: "#ffffff",
      logging:         false,
    });

    const pdf      = new JsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
    const pageW    = pdf.internal.pageSize.getWidth();
    const pageH    = pdf.internal.pageSize.getHeight();
    const usableW  = pageW - 2 * MARGIN_PT;
    const usableH  = pageH - 2 * MARGIN_PT;
    const imgW     = usableW;
    const imgH     = (canvas.height * imgW) / canvas.width;
    const imgData  = canvas.toDataURL("image/jpeg", 0.95);

    if (imgH <= usableH) {
      pdf.addImage(imgData, "JPEG", MARGIN_PT, MARGIN_PT, imgW, imgH);
    } else {
      // Multi-page with safe-break scan — verbatim port of TailoredCvCard logic
      const pageHpx = (canvas.width * usableH) / usableW;
      const srcCtx  = canvas.getContext("2d", { willReadFrequently: true });
      if (!srcCtx) throw new Error("Source canvas 2D context unavailable");

      const scanBackPx = Math.floor(pageHpx * SCAN_BACK_FRAC);

      const findSafeBreak = (idealY: number): number => {
        const minY = Math.max(idealY - scanBackPx, 1);
        const strip = srcCtx.getImageData(0, minY, canvas.width, idealY - minY);
        for (let yRel = strip.height - 1; yRel >= 0; yRel--) {
          let rowIsBlank = true;
          const rowStart = yRel * strip.width * 4;
          for (let x = 0; x < strip.width; x++) {
            const i = rowStart + x * 4;
            if (strip.data[i] < 245 || strip.data[i + 1] < 245 || strip.data[i + 2] < 245) {
              rowIsBlank = false;
              break;
            }
          }
          if (rowIsBlank) return minY + yRel;
        }
        return idealY;
      };

      let yPx = 0;
      let pageCount = 0;
      while (yPx < canvas.height) {
        const remaining = canvas.height - yPx;
        const idealEndY = yPx + Math.min(pageHpx, remaining);
        const isLastPage = idealEndY >= canvas.height - 1;
        const endY = isLastPage ? canvas.height : findSafeBreak(idealEndY);
        const sliceH = endY - yPx;

        const slice = document.createElement("canvas");
        slice.width  = canvas.width;
        slice.height = sliceH;
        const ctx = slice.getContext("2d");
        if (!ctx) throw new Error("Slice canvas 2D context unavailable");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, -yPx);

        if (pageCount > 0) pdf.addPage();
        const sliceData = slice.toDataURL("image/jpeg", 0.95);
        const sliceImgH = (sliceH * imgW) / canvas.width;
        pdf.addImage(sliceData, "JPEG", MARGIN_PT, MARGIN_PT, imgW, sliceImgH);

        yPx = endY;
        pageCount += 1;
      }
    }

    return pdf.output("blob");
  } finally {
    if (root) root.unmount();
    if (host.parentNode) host.parentNode.removeChild(host);
  }
}
