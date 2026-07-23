"use client";

/** Tailored-CV action button driven by useTailoredCvPdf (split out of CardV2). */
import { FileText } from "lucide-react";
import { Button } from "@/components/ui";
import type { useTailoredCvPdf } from "../hooks/useTailoredCvPdf";

export function TailoredCvButton({ cvPdf }: { cvPdf: ReturnType<typeof useTailoredCvPdf> }) {
  const { state, url, ensure } = cvPdf;
  if (!url) return null;

  if (state === "ready") {
    return (
      <Button asChild variant="default" size="xs">
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1"
          title="Open tailored CV PDF in new tab">
          <FileText className="w-3 h-3" /> Tailored CV
        </a>
      </Button>
    );
  }
  if (state === "error") {
    return (
      <Button onClick={ensure}
        size="xs"
        icon={<FileText className="w-3 h-3" />}
        title="Preparing the CV PDF failed — click to retry">
        Tailored CV
      </Button>
    );
  }
  return (
    <Button disabled isLoading
      size="xs"
      title="Preparing tailored CV PDF…">
      Tailored CV
    </Button>
  );
}

// ── Entry point ─────────────────────────────────────────────────────────

