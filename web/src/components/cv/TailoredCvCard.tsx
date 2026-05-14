"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createClient } from "@/lib/supabase/client";

interface Props {
  storagePath:    string | null;   // markdown path
  pdfStoragePath: string | null;   // PDF path (may lag the markdown by a few seconds)
  runId:          string;          // for download filename
}

/**
 * Fetches the tailored CV markdown from Supabase Storage (RLS-scoped to the
 * user's own folder) and renders it inline. Phase 7 adds a 'Download PDF'
 * button alongside.
 */
export function TailoredCvCard({ storagePath, pdfStoragePath, runId }: Props) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function handleDownloadPdf() {
    if (!pdfStoragePath) return;
    setDownloading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from("tailored-cvs")
        .download(pdfStoragePath);
      if (error || !data) throw new Error(error?.message ?? "Download failed");
      // Trigger a browser save dialog
      const url = URL.createObjectURL(data);
      const a   = document.createElement("a");
      a.href     = url;
      a.download = `tailored-cv-${runId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    if (!storagePath) return;
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        // Object path under 'tailored-cvs' bucket: '{user_id}/{run_id}.md'
        const { data, error } = await supabase.storage
          .from("tailored-cvs")
          .download(storagePath);
        if (error || !data) {
          if (active) setErr(error?.message ?? "Could not load tailored CV");
          return;
        }
        const text = await data.text();
        if (active) setMd(text);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => { active = false; };
  }, [storagePath]);

  if (!storagePath) return null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-text">Tailored CV</h2>
          <p className="text-[12px] text-text-3 mt-0.5">
            AI-rewritten for this job, with approved keywords injected.
          </p>
        </div>
        {pdfStoragePath ? (
          <button
            onClick={handleDownloadPdf}
            disabled={downloading}
            className="gh-btn gh-btn-primary text-[12px] inline-flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/>
            </svg>
            {downloading ? "Downloading…" : "Download PDF"}
          </button>
        ) : (
          <span className="text-[10px] text-text-3 italic">PDF rendering…</span>
        )}
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
                          prose-h1:text-[18px] prose-h2:text-[14px] prose-h3:text-[13px]
                          prose-strong:text-text prose-li:my-0.5
                          font-serif">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
