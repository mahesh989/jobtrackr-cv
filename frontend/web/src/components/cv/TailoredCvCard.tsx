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
import { renderTailoredCvHtml, renderTailoredCvBlob } from "@/lib/cvPdfRender";

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

  // ── Download .md (raw) ────────────────────────────────────────────────────
  function handleDownloadMd() {
    if (!formattedMd) return;
    const blob = new Blob([formattedMd], { type: "text/markdown;charset=utf-8" });
    triggerDownload(blob, `tailored-cv-${runId.slice(0, 8)}.md`);
  }

  // ── Print / PDF — open clean window, then call window.print ───────────────
  async function handlePrint() {
    // Open the window synchronously (inside the click gesture) so popup
    // blockers don't eat it. Populate after the async rendering completes.
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) return;
    win.document.write("<p>Preparing…</p>");
    try {
      const html = await renderTailoredCvHtml({ markdown: rawMd || "", contactDetails: contact });
      win.document.open();
      win.document.write(buildPrintDocument(html));
      win.document.close();
      setTimeout(() => win.print(), 300);
    } catch (e) {
      win.close();
      setErr(e instanceof Error ? e.message : "Print preparation failed");
    }
  }

  // ── Download PDF — html2canvas-pro + jsPDF client-side render ───────────
  async function handleDownloadPdf() {
    setDP(true); setErr(null);
    try {
      const pdfBlob = await renderTailoredCvBlob({ markdown: rawMd || "", contactDetails: contact });
      triggerDownload(pdfBlob, `tailored-cv-${runId.slice(0, 8)}.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "PDF generation failed");
    } finally {
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
                            prose-a:text-[#000080]
                            prose-table:border-none prose-tr:border-none prose-th:border-none prose-td:border-none
                            prose-thead:hidden
                            prose-th:p-0 prose-td:p-0">
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
