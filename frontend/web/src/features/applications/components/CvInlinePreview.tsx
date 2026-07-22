"use client";

/**
 * CvInlinePreview — embeds the tailored CV preview inline inside an Application
 * pool card. Lazy-loads the CV markdown from Storage on mount and renders it
 * with the same chain TailoredCvCard uses (ReactMarkdown + remarkGfm +
 * applyCvSectionLayout + boldSkillCategories + padPipesAndCleanArtifacts +
 * stampContactClient + tidyContactLine).
 *
 * Same VISUAL render as the Full Analysis page preview. Background is a white
 * "paper" inside the card chrome so it reads as a CV preview. The container
 * adopts the card's theme background.
 *
 * Read-only here — editing the CV happens on the analysis page. This is just
 * a glanceable confirmation of what gets attached when the user sends.
 */

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  applyCvSectionLayout,
  boldSkillCategories,
  padPipesAndCleanArtifacts,
  stampContactClient,
  tidyContactLine,
} from "@/lib/cv/markdownHelpers";
import type { ContactDetails } from "@/lib/types";

interface Props {
  storagePath: string | null;
}

export function CvInlinePreview({ storagePath }: Props) {
  const [rawMd,   setRawMd]   = useState<string | null>(null);
  const [contact, setContact] = useState<ContactDetails | null>(null);
  const [err,     setErr]     = useState<string | null>(null);
  const previewRef            = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!storagePath) return;
    let active = true;
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.storage.from("tailored-cvs").download(storagePath);
        if (error || !data) {
          if (active) setErr(error?.message ?? "Could not load tailored CV");
          return;
        }
        const text = await data.text();
        if (active) setRawMd(text);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => { active = false; };
  }, [storagePath]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/user/preferences");
        if (!res.ok) return;
        const json = await res.json();
        if (active && json?.contact_details) {
          const { projects: _projects, ...cd } = json.contact_details ?? {};
          void _projects;
          setContact(cd as ContactDetails);
        }
      } catch { /* non-fatal */ }
    })();
    return () => { active = false; };
  }, []);

  const formattedMd = rawMd
    ? padPipesAndCleanArtifacts(
        boldSkillCategories(
          stampContactClient(tidyContactLine(rawMd), contact),
        ),
      )
    : null;

  // Apply the two-column row layout to the rendered DOM (matches PDF output).
  useEffect(() => {
    if (!formattedMd) return;
    const t = setTimeout(() => {
      if (previewRef.current) applyCvSectionLayout(previewRef.current);
    }, 50);
    return () => clearTimeout(t);
  }, [formattedMd]);

  const displayErr = err ?? (!storagePath ? "No tailored CV markdown for this job" : null);

  return (
    <div className="rounded-md border border-border bg-[var(--surface-2)] overflow-hidden">
      <div className="bg-white p-5 max-h-[420px] overflow-y-auto" style={{ colorScheme: "light" }}>
        {displayErr ? (
          <p className="text-label text-red-600 italic">{displayErr}</p>
        ) : !formattedMd ? (
          <div className="py-8 flex items-center justify-center text-gray-500 text-label">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading tailored CV…
          </div>
        ) : (
          <div
            ref={previewRef}
            className="prose prose-sm max-w-none text-gray-900
                       prose-headings:text-gray-900 prose-p:text-gray-800
                       prose-li:text-gray-800 prose-strong:text-gray-900
                       prose-a:text-[#000080]"
          >
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
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-border bg-[var(--surface-2)]">
        <p className="text-micro text-text-3">
          Same format as the Full Analysis page preview. Scroll to see more.
        </p>
      </div>
    </div>
  );
}
