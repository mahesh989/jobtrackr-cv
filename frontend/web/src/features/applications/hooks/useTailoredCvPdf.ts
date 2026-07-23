"use client";

/**
 * Ensure-cached tailored-CV PDF hook (split out of CardV2.tsx).
 * HEAD-checks the cache, renders client-side on miss, PUTs the bytes.
 */
import { useCallback, useRef, useState } from "react";
import { renderTailoredCvBlob } from "@/lib/cv/pdfRender";
import { loadCvInputs } from "../lib/cvPdfClient";
import type { ApplicationRowV2 } from "../components/CardV2";

export type CvPdfState = "idle" | "preparing" | "ready" | "error";


export function useTailoredCvPdf(row: ApplicationRowV2, onError?: (msg: string) => void) {
  const [state, setState] = useState<CvPdfState>("idle");
  const started = useRef(false);
  const url = row.letter_id ? `/api/applications/${row.letter_id}/tailored-cv-pdf` : null;

  const ensure = useCallback(async () => {
    if (!url || !row.tailored_cv_storage_path) return;
    if (started.current) return;
    started.current = true;
    setState("preparing");
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) { setState("ready"); return; }
      const { markdown, contactDetails } = await loadCvInputs(row.tailored_cv_storage_path);
      const blob = await renderTailoredCvBlob({ markdown, contactDetails });
      const res = await fetch(url, {
        method:  "PUT",
        headers: { "Content-Type": "application/pdf" },
        body:    blob,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Could not prepare CV (${res.status})`);
      }
      setState("ready");
    } catch (e) {
      started.current = false;
      setState("error");
      onError?.(e instanceof Error ? e.message : "Could not prepare tailored CV PDF");
    }
  }, [url, row.tailored_cv_storage_path, onError]);

  return { state, url, ensure };
}

