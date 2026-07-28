"use client";

/**
 * Download ▾ — the single place to get a job's files out of the app.
 *
 * Lives in the panel header rather than a tab because downloading is an action
 * on the whole job, not content you read. It replaces the More tab, whose
 * "Download ZIP" silently changed shape depending on which artifacts existed,
 * so you could never tell what you were about to get.
 *
 * All three items always render; the ones this job can't produce are disabled
 * with the reason, which is how the user learns what exists.
 *
 * No `editedBody` override is passed to the bundle: cover-letter edits now save
 * to `pass_3_final`, so the server-rendered letter PDF is already current. The
 * More tab never passed the override at all and quietly shipped stale text.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileText, FileType, Loader2, Package } from "lucide-react";
import { downloadApplicationBundle } from "@/lib/downloadZip";
import { useTailoredCvPdfAction } from "./useTailoredCvPdfAction";

type Busy = "zip" | "cv" | null;

export function DownloadMenu({
  jobId, company, hiringManager, cvStoragePath, letterId, loaded,
}: {
  jobId:          string;
  company:        string | null;
  hiringManager:  string | null;
  /** Markdown path for the tailored CV. Null until the pane payload lands. */
  cvStoragePath:  string | null;
  letterId:       string | null;
  /** False while the per-job payload is in flight — items stay disabled rather
   *  than firing against paths we don't have yet. */
  loaded:         boolean;
}) {
  const [open, setOpen]   = useState(false);
  const [busy, setBusy]   = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // downloadPdf swallows its own failures into `cvError` rather than throwing,
  // so both error channels have to be surfaced.
  const { downloadPdf, pending: cvPending, error: cvError } = useTailoredCvPdfAction(cvStoragePath);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasCv     = loaded && !!cvStoragePath;
  const hasLetter = loaded && !!letterId;
  const notReady  = !loaded ? "Still loading this job's files…" : null;

  async function downloadZip() {
    if (busy || !cvStoragePath || !letterId) return;
    setBusy("zip"); setError(null);
    try {
      await downloadApplicationBundle({
        jobId,
        letterId,
        cvStoragePath,
        // downloadApplicationBundle falls back to "Company" on an empty string.
        companyName:   company ?? "",
        hiringManager: hiringManager ?? null,
      });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  async function downloadCv() {
    if (busy || !cvStoragePath) return;
    setBusy("cv"); setError(null);
    try {
      await downloadPdf(`tailored-cv-${jobId.slice(0, 8)}`);
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null || cvPending !== null;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap border border-border bg-surface text-text-2 hover:border-[var(--brand)] hover:text-[var(--brand)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
      >
        {working ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        Download
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 z-30 w-[264px] rounded-[10px] border border-border bg-surface shadow-lg overflow-hidden">
          <MenuRow
            icon={<Package className="w-4 h-4" />}
            label="Download both"
            sub="Tailored CV + cover letter (.zip)"
            disabledReason={notReady ?? (!hasCv ? "No tailored CV for this job yet" : !hasLetter ? "No cover letter for this job yet" : null)}
            busy={busy === "zip"}
            onClick={downloadZip}
          />
          <MenuRow
            icon={<FileText className="w-4 h-4" />}
            label="Tailored CV only"
            sub="PDF, ATS-optimised"
            disabledReason={notReady ?? (!hasCv ? "No tailored CV for this job yet" : null)}
            busy={busy === "cv" || cvPending === "download"}
            onClick={downloadCv}
          />
          <MenuRow
            icon={<FileType className="w-4 h-4" />}
            label="Cover letter only"
            sub="PDF"
            disabledReason={notReady ?? (!hasLetter ? "No cover letter for this job yet" : null)}
            href={letterId ? `/api/jobs/${jobId}/cover-letter/${letterId}/download?format=pdf` : undefined}
            onClick={() => setOpen(false)}
          />
          {(error ?? cvError) && (
            <p className="px-3.5 py-2 text-[12px] text-red border-t border-[var(--border-muted)]">{error ?? cvError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon, label, sub, disabledReason, busy = false, href, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  disabledReason: string | null;
  busy?: boolean;
  href?: string;
  onClick: () => void;
}) {
  const disabled = !!disabledReason;
  const inner = (
    <>
      <span className="shrink-0 text-text-3">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-text">{label}</span>
        <span className="block text-[11.5px] text-text-3">{disabledReason ?? sub}</span>
      </span>
    </>
  );
  const cls =
    "w-full flex items-start gap-2.5 px-3.5 py-2.5 text-left border-b border-[var(--border-muted)] last:border-b-0 " +
    (disabled
      ? "opacity-45 cursor-not-allowed"
      : "hover:bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand)]");

  // The cover-letter route already responds `Content-Disposition: attachment`,
  // so an anchor is the whole implementation — no blob juggling needed.
  if (href && !disabled) {
    return (
      <a role="menuitem" href={href} download onClick={onClick} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled || busy}
      title={disabledReason ?? undefined}
      onClick={onClick}
      className={cls}
    >
      {inner}
    </button>
  );
}
