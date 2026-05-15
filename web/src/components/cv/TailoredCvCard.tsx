"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createClient } from "@/lib/supabase/client";

interface Props {
  storagePath:    string | null;     // markdown path
  pdfStoragePath: string | null;     // PDF path
  runId:          string;
}

/**
 * Faithful port of cv-magic's TailoredCVCard:
 *   - Preview (inline render of the markdown)
 *   - Print / PDF (browser print dialog using the rendered HTML)
 *   - Download .md (raw markdown)
 *   - Download PDF (ReportLab-rendered PDF from cv-backend)
 */
export function TailoredCvCard({ storagePath, pdfStoragePath, runId }: Props) {
  const [md, setMd]                 = useState<string | null>(null);
  const [err, setErr]               = useState<string | null>(null);
  const [downloadingPdf, setDP]     = useState(false);

  useEffect(() => {
    if (!storagePath) return;
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.storage
          .from("tailored-cvs")
          .download(storagePath);
        if (error || !data) { if (active) setErr(error?.message ?? "Could not load tailored CV"); return; }
        const text = await data.text();
        if (active) setMd(text);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => { active = false; };
  }, [storagePath]);

  function handleDownloadMd() {
    if (!md) return;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    triggerDownload(blob, `tailored-cv-${runId.slice(0, 8)}.md`);
  }

  async function handleDownloadPdf() {
    if (!pdfStoragePath) return;
    setDP(true); setErr(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from("tailored-cvs")
        .download(pdfStoragePath);
      if (error || !data) throw new Error(error?.message ?? "Download failed");
      triggerDownload(data, `tailored-cv-${runId.slice(0, 8)}.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDP(false);
    }
  }

  function handlePrint() {
    if (!md) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tailored CV</title>
<style>
  body { font: 11pt/1.5 Helvetica, Arial, sans-serif; max-width: 800px; margin: 24px auto; padding: 0 32px; color: #1f2328; }
  h1 { font-size: 22pt; margin: 0 0 6px; }
  h2 { font-size: 11pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; margin: 18px 0 8px; }
  h3 { font-size: 11pt; margin: 10px 0 4px; }
  ul { margin: 4px 0 8px; padding-left: 18px; }
  li { margin: 2px 0; }
  a  { color: #1f2328; text-decoration: underline; }
  p  { margin: 4px 0; }
</style></head><body>${markdownToHtml(md)}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  if (!storagePath) return null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[14px] font-semibold text-text">Tailored CV</h2>
          <p className="text-[12px] text-text-3 mt-0.5">
            Preview, print, or download as markdown or PDF.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={handlePrint} disabled={!md} className="gh-btn text-[11px] px-2 py-1" title="Open in a printable window">
            Print / PDF
          </button>
          <button onClick={handleDownloadMd} disabled={!md} className="gh-btn text-[11px] px-2 py-1">
            Download .md
          </button>
          {pdfStoragePath ? (
            <button
              onClick={handleDownloadPdf}
              disabled={downloadingPdf}
              className="gh-btn gh-btn-primary text-[11px] px-2 py-1 inline-flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/>
              </svg>
              {downloadingPdf ? "Downloading…" : "Download PDF"}
            </button>
          ) : (
            <span className="text-[10px] text-text-3 italic">PDF rendering…</span>
          )}
        </div>
      </div>
      <div className="px-5 py-4">
        {err && (
          <div className="rounded-md bg-red-light border border-red/20 px-3 py-2 text-[12px] text-red">
            {err}
          </div>
        )}
        {!md && !err && (
          <p className="text-[12px] text-text-3 italic">Loading…</p>
        )}
        {md && (
          <div className="prose prose-sm max-w-none text-text-2 leading-relaxed
                          prose-headings:text-text prose-headings:font-semibold
                          prose-h1:text-[18px] prose-h2:text-[13px] prose-h2:uppercase prose-h2:tracking-wide
                          prose-h3:text-[13px]
                          prose-strong:text-text prose-li:my-0.5
                          font-serif">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// Helpers ---------------------------------------------------------------------

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

// Very small markdown → HTML converter for the print preview. Avoids pulling
// in a second library; covers what the tailored CV emits (headings, bullets,
// bold, links).
function markdownToHtml(md: string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (/^#{1,3} /.test(ln)) {
      if (inList) { out.push("</ul>"); inList = false; }
      const lvl = (ln.match(/^#+/)![0]).length;
      const text = ln.replace(/^#+\s+/, "");
      out.push(`<h${lvl}>${inlineFmt(text)}</h${lvl}>`);
    } else if (/^\s*[-*]\s+/.test(ln)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inlineFmt(ln.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (ln.trim() === "") {
      if (inList) { out.push("</ul>"); inList = false; }
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${inlineFmt(ln)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");

  function inlineFmt(s: string): string {
    let r = escape(s);
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    return r;
  }
}
