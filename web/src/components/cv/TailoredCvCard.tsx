"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createClient } from "@/lib/supabase/client";
import {
  applyCvSectionLayout,
  boldSkillCategories,
  padPipesAndCleanArtifacts,
  stampContactClient,
  tidyContactLine,
  type ContactDetails,
} from "@/lib/cvMarkdownHelpers";
import { CV_PDF_STYLE } from "@/lib/cvPdfStyle";

interface Props {
  storagePath:    string | null;   // markdown path in tailored-cvs bucket
  pdfStoragePath: string | null;   // server-rendered PDF path (legacy fallback)
  runId:          string;
}

/**
 * Faithful port of cv-magic's TailoredCVCard:
 *   - Preview toggle (Preview / Hide)
 *   - Print / PDF: opens a clean window with the rendered HTML and triggers print
 *   - Download .md: raw markdown
 *   - Download PDF: client-side html2canvas-pro + jsPDF render — supports modern
 *     CSS color functions (lab/oklch) that Tailwind v4 emits, and always
 *     matches the preview
 *
 * The contact line on the markdown is re-stamped client-side from the user's
 * saved contact_details in /api/user/preferences, so updates to your profile
 * appear in the preview + PDF without re-running the analysis.
 */
export function TailoredCvCard({ storagePath, pdfStoragePath, runId }: Props) {
  const [rawMd, setRawMd]   = useState<string | null>(null);
  const [contact, setContact] = useState<ContactDetails | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [downloadingPdf, setDP] = useState(false);
  const [err, setErr]       = useState<string | null>(null);
  const previewRef          = useRef<HTMLDivElement>(null);

  // Load markdown from Storage once.
  useEffect(() => {
    if (!storagePath) return;
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.storage.from("tailored-cvs").download(storagePath);
        if (error || !data) { if (active) setErr(error?.message ?? "Could not load tailored CV"); return; }
        const text = await data.text();
        if (active) setRawMd(text);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => { active = false; };
  }, [storagePath]);

  // Fetch latest contact details so updates land in the preview/PDF.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/user/preferences");
        if (!res.ok) return;
        const json = await res.json();
        if (active && json?.contact_details) {
          // Strip the projects sub-array — only contact fields go into the stamp.
          const { projects: _projects, ...cd } = json.contact_details ?? {};
          void _projects;
          setContact(cd as ContactDetails);
        }
      } catch { /* non-fatal */ }
    })();
    return () => { active = false; };
  }, []);

  // Apply cv-magic's formatter chain + the new client-side contact stamp.
  const formattedMd = rawMd
    ? padPipesAndCleanArtifacts(
        boldSkillCategories(
          stampContactClient(tidyContactLine(rawMd), contact),
        ),
      )
    : null;

  // Apply the two-column row layout (institution | location, title | date,
  // etc.) to the preview DOM so the preview matches the PDF output.
  // Previously this only ran at PDF-download time, which is why the Education
  // section appeared as wide bold headings in preview but looked correct in
  // the downloaded PDF. Run it after every ReactMarkdown render.
  useEffect(() => {
    if (!showPreview || !formattedMd) return;
    // Wait for ReactMarkdown to paint, then mutate.
    // applyCvSectionLayout is idempotent on already-converted DOM (it looks
    // for H3 elements; after conversion they're cv-row divs and won't match),
    // so it's safe to run on every formattedMd change.
    const t = setTimeout(() => {
      if (previewRef.current) {
        applyCvSectionLayout(previewRef.current);
      }
    }, 50);
    return () => clearTimeout(t);
  }, [showPreview, formattedMd]);

  function ensurePreviewVisible(): Promise<HTMLElement | null> {
    setShowPreview(true);
    return new Promise((resolve) => setTimeout(() => resolve(previewRef.current), 100));
  }

  // ── Download .md (raw) ────────────────────────────────────────────────────
  function handleDownloadMd() {
    if (!formattedMd) return;
    const blob = new Blob([formattedMd], { type: "text/markdown;charset=utf-8" });
    triggerDownload(blob, `tailored-cv-${runId.slice(0, 8)}.md`);
  }

  // ── Print / PDF — open clean window, then call window.print ───────────────
  async function handlePrint() {
    const root = await ensurePreviewVisible();
    if (!root) return;
    const html = root.innerHTML;
    if (!html) return;
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) return;
    win.document.write(buildPrintDocument(html));
    win.document.close();
    setTimeout(() => win.print(), 300);
  }

  // ── Download PDF — html2canvas-pro + jsPDF client-side render ───────────
  async function handleDownloadPdf() {
    const root = await ensurePreviewVisible();
    setDP(true); setErr(null);
    let wrapper: HTMLDivElement | null = null;
    try {
      const html = root?.innerHTML;
      if (!html) throw new Error("Preview HTML is empty");

      // A4 content area = 794px page width − 2 × 36px (0.5in) margin = 722px
      const PAGE_W_PX = 794;   // 8.27in @ 96dpi
      const PAGE_H_PX = 1123;  // 11.69in @ 96dpi
      const MARGIN_PT = 36;    // 0.5in
      const CONTENT_W_PX = PAGE_W_PX - 2 * 48;  // 698px (matches preview)

      wrapper = document.createElement("div");
      Object.assign(wrapper.style, {
        position: "fixed", left: "0", top: "0",
        width: `${CONTENT_W_PX}px`,
        padding: "0",
        background: "#ffffff",
        opacity: "0",
        pointerEvents: "none",
        zIndex: "-1",
        // Reset inherited color so html2canvas-pro never has to parse a
        // Tailwind v4 lab()/oklch() value from a parent.
        color: "#000000",
        colorScheme: "light",
      });
      wrapper.innerHTML = `<style>${CV_PDF_STYLE}</style><main class="cv-root">${html}</main>`;
      document.body.appendChild(wrapper);
      const cvRoot = wrapper.querySelector(".cv-root") as HTMLElement | null;
      if (!cvRoot) throw new Error("cv-root not found");
      applyCvSectionLayout(cvRoot);
      // Two RAF ticks so layout settles before snapshot.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));

      const [{ default: html2canvas }, { default: JsPDF }] = await Promise.all([
        import("html2canvas-pro"),
        import("jspdf"),
      ]);

      const canvas = await html2canvas(cvRoot, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        // Fail fast on weird CSS rather than swallow it silently.
        logging: false,
      });

      const pdf = new JsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const usableW = pageW - 2 * MARGIN_PT;
      // Convert canvas px → pt to keep proportions
      const imgW = usableW;
      const imgH = (canvas.height * imgW) / canvas.width;
      const usableH = pageH - 2 * MARGIN_PT;

      const imgData = canvas.toDataURL("image/jpeg", 0.95);

      if (imgH <= usableH) {
        pdf.addImage(imgData, "JPEG", MARGIN_PT, MARGIN_PT, imgW, imgH);
      } else {
        // Multi-page: slice the canvas vertically. Instead of cutting at the
        // exact pixel where the page boundary lands (which slices through the
        // middle of text lines), scan upward from the ideal cut to find a row
        // of all-white pixels — text never lives on a fully-white row, so
        // cutting there cleanly breaks between lines/paragraphs/sections.
        const pageHpx  = (canvas.width * usableH) / usableW;
        const srcCtx   = canvas.getContext("2d", { willReadFrequently: true });
        if (!srcCtx) throw new Error("Source canvas 2D context unavailable");

        // How far we're willing to scan upward to find a clean break before
        // giving up and using the original cut point. 18% of a page is enough
        // to clear a line of text or a section header but won't sacrifice a
        // huge portion of usable space.
        const SCAN_BACK_PX = Math.floor(pageHpx * 0.18);

        const findSafeBreak = (idealY: number): number => {
          const minY = Math.max(idealY - SCAN_BACK_PX, 1);
          // Read the strip we need to scan in one go for performance.
          const strip = srcCtx.getImageData(0, minY, canvas.width, idealY - minY);
          // Scan rows from bottom up.
          for (let yRel = strip.height - 1; yRel >= 0; yRel--) {
            let rowIsBlank = true;
            const rowStart = yRel * strip.width * 4;
            for (let x = 0; x < strip.width; x++) {
              const i = rowStart + x * 4;
              // Treat anything darker than ~245/255 on any channel as content.
              if (strip.data[i] < 245 || strip.data[i + 1] < 245 || strip.data[i + 2] < 245) {
                rowIsBlank = false;
                break;
              }
            }
            if (rowIsBlank) return minY + yRel;
          }
          // No clean break found — fall back to the original cut.
          return idealY;
        };

        let yPx = 0;
        let pageCount = 0;
        while (yPx < canvas.height) {
          const remaining = canvas.height - yPx;
          // Ideal bottom of this page in source-canvas coords.
          const idealEndY = yPx + Math.min(pageHpx, remaining);
          // If this is the last page (everything fits), just take the rest.
          const isLastPage = idealEndY >= canvas.height - 1;
          const endY = isLastPage ? canvas.height : findSafeBreak(idealEndY);
          const sliceH = endY - yPx;

          const slice = document.createElement("canvas");
          slice.width  = canvas.width;
          slice.height = sliceH;
          const ctx = slice.getContext("2d");
          if (!ctx) throw new Error("Canvas 2D context unavailable");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, slice.width, slice.height);
          ctx.drawImage(canvas, 0, -yPx);

          if (pageCount > 0) pdf.addPage();
          const sliceData = slice.toDataURL("image/jpeg", 0.95);
          const sliceImgH = (sliceH * imgW) / canvas.width;
          pdf.addImage(sliceData, "JPEG", MARGIN_PT, MARGIN_PT, imgW, sliceImgH);

          yPx = endY;
          pageCount += 1;
          void PAGE_H_PX; // suppress unused-var: we use pdf.internal.pageSize instead
        }
      }

      pdf.save(`tailored-cv-${runId.slice(0, 8)}.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "PDF generation failed");
    } finally {
      if (wrapper?.parentNode) wrapper.parentNode.removeChild(wrapper);
      setDP(false);
    }
  }

  // ── Fallback: server-rendered PDF download (still available) ─────────────
  async function handleServerPdf() {
    if (!pdfStoragePath) return;
    setDP(true); setErr(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.storage.from("tailored-cvs").download(pdfStoragePath);
      if (error || !data) throw new Error(error?.message ?? "Download failed");
      triggerDownload(data, `tailored-cv-${runId.slice(0, 8)}-server.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDP(false);
    }
  }
  void handleServerPdf; // kept for reference; UI uses html2pdf path

  if (!storagePath) return null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[14px] font-semibold text-text">Tailored CV</h2>
          <p className="text-[12px] text-text-3 mt-0.5">
            Preview, print, or download as Markdown or PDF.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowPreview((v) => !v)}
            disabled={!formattedMd}
            className="gh-btn text-[11px] px-2 py-1"
          >
            {showPreview ? "Hide" : "Preview"}
          </button>
          <button onClick={handlePrint} disabled={!formattedMd} className="gh-btn text-[11px] px-2 py-1">
            Print / PDF
          </button>
          <button onClick={handleDownloadMd} disabled={!formattedMd} className="gh-btn text-[11px] px-2 py-1">
            Download .md
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={!formattedMd || downloadingPdf}
            className="gh-btn gh-btn-primary text-[11px] px-2 py-1"
          >
            {downloadingPdf ? "Rendering…" : "Download PDF"}
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        {err && (
          <div className="rounded-md bg-red-light border border-red/20 px-3 py-2 text-[12px] text-red mb-3">
            {err}
          </div>
        )}
        {!formattedMd && !err && (
          <p className="text-[12px] text-text-3 italic">Loading…</p>
        )}

        {showPreview && formattedMd && (
          <div ref={previewRef} className="rounded-md border border-border bg-white p-5">
            <div className="prose prose-sm max-w-none text-gray-900
                            prose-headings:text-gray-900 prose-p:text-gray-800
                            prose-li:text-gray-800 prose-strong:text-gray-900
                            prose-a:text-[#000080]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
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
            </div>
          </div>
        )}
        {!showPreview && formattedMd && (
          <p className="text-[12px] text-text-3">
            Your tailored CV is ready. Preview to inspect, download as Markdown,
            or render to PDF.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildPrintDocument(rawHtml: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Tailored CV</title>
<style>${CV_PDF_STYLE}</style>
</head><body><main class="cv-root">${rawHtml}</main>
<script>
  (${String(applyCvSectionLayout)})(document.querySelector(".cv-root"));
</script></body></html>`;
}
