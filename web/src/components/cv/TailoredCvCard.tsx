"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createClient } from "@/lib/supabase/client";

interface Props {
  storagePath: string | null;
}

/**
 * Fetches the tailored CV markdown from Supabase Storage (RLS-scoped to the
 * user's own folder) and renders it inline. Phase 7 adds a 'Download PDF'
 * button alongside.
 */
export function TailoredCvCard({ storagePath }: Props) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
            AI-rewritten for this job, with approved keywords injected. PDF
            download lands in the next phase.
          </p>
        </div>
        <span className="text-[10px] text-text-3 bg-surface border border-border px-1.5 py-0.5 rounded">
          MARKDOWN
        </span>
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
