"use client";

/**
 * Client-side "View PDF" / "Download PDF" for a tailored CV, keyed only by
 * its storage path — unlike `useTailoredCvPdf` (applications feature), this
 * has NO letter_id dependency, so it works for board-detail cases where a
 * tailored CV exists but no cover letter was generated yet (e.g. the
 * below-final-gate "cover letter skipped" state).
 *
 * Reuses the exact render chain `TailoredCvCard`/`CvInlinePreview` use
 * (markdownHelpers + renderTailoredCvBlob) so the output is byte-identical.
 */
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  boldSkillCategories,
  padPipesAndCleanArtifacts,
  stampContactClient,
  tidyContactLine,
} from "@/lib/cv/markdownHelpers";
import { renderTailoredCvBlob } from "@/lib/cv/pdfRender";
import type { ContactDetails } from "@/lib/types";

async function loadMarkdownAndContact(storagePath: string) {
  const supabase = createClient();
  const [{ data: mdBlob, error }, prefsRes] = await Promise.all([
    supabase.storage.from("tailored-cvs").download(storagePath),
    fetch("/api/user/preferences"),
  ]);
  if (error || !mdBlob) throw new Error(error?.message ?? "Could not load tailored CV");
  const rawMd = await mdBlob.text();

  let contact: ContactDetails | null = null;
  if (prefsRes.ok) {
    const json = await prefsRes.json().catch(() => null);
    if (json?.contact_details) {
      const { projects: _projects, ...cd } = json.contact_details ?? {};
      void _projects;
      contact = cd as ContactDetails;
    }
  }

  const formatted = padPipesAndCleanArtifacts(
    boldSkillCategories(stampContactClient(tidyContactLine(rawMd), contact)),
  );
  return { rawMd, formatted, contact };
}

export function useTailoredCvPdfAction(storagePath: string | null) {
  const [pending, setPending] = useState<"view" | "download" | null>(null);
  const [error, setError]     = useState<string | null>(null);

  async function viewPdf() {
    if (!storagePath || pending) return;
    setPending("view"); setError(null);
    try {
      const { rawMd, contact } = await loadMarkdownAndContact(storagePath);
      const blob = await renderTailoredCvBlob({ markdown: rawMd, contactDetails: contact });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not render PDF");
    } finally {
      setPending(null);
    }
  }

  async function downloadPdf(filenameHint = "tailored-cv") {
    if (!storagePath || pending) return;
    setPending("download"); setError(null);
    try {
      const { rawMd, contact } = await loadMarkdownAndContact(storagePath);
      const blob = await renderTailoredCvBlob({ markdown: rawMd, contactDetails: contact });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameHint}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not render PDF");
    } finally {
      setPending(null);
    }
  }

  return { pending, error, viewPdf, downloadPdf };
}
