"use client";

/**
 * SentCard — minimal done-state card on the Sent/Applied tab (split out of
 * CardV2.tsx). Surfaces the sent email message + un-apply/un-archive.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight, Mail, FileText, FileType,
  CheckCircle2, Archive, Loader2, Download } from "lucide-react";
import { Badge } from "@/components/ui";
import { markJobDismissed, markJobUnapplied } from "@/lib/actions";
import { renderTailoredCvBlob } from "@/lib/cv/pdfRender";
import { downloadApplicationBundle } from "@/lib/downloadZip";
import { SentEmailModal } from "./SentEmailModal";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui";
import { relativeDate } from "@/lib/dates";

import { presentBlob, loadCvInputs } from "../lib/cvPdfClient";
import { useTailoredCvPdf } from "../hooks/useTailoredCvPdf";
import { TailoredCvButton } from "./TailoredCvButton";
import { scoreColor, type ApplicationRowV2 } from "./CardV2";

export function SentCard({ row, onActioned }: { row: ApplicationRowV2; onActioned?: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [showEmail, setShowEmail]       = useState(false);
  const [hidden, setHidden]             = useState(false);
  const [zipping, setZipping]           = useState(false);
  const [movingBack, setMovingBack]     = useState(false);
  const [actionError, setActionError]   = useState<string | null>(null);
  const [cvPreviewing, setCvPreviewing] = useState(false);

  const isApplied  = !!row.job_applied_at;
  const isArchived = !!row.job_dismissed_at && !isApplied;

  const cvPdf = useTailoredCvPdf(row, setActionError);
  const ensureCvPdf = cvPdf.ensure;
  useEffect(() => { if (row.letter_id) ensureCvPdf(); }, [row.letter_id, ensureCvPdf]);

  async function previewTailoredCv() {
    if (cvPreviewing || !row.tailored_cv_storage_path) return;
    const win = window.open("", "_blank");
    if (win) {
      try { win.document.write("<html><body style='font-family:sans-serif;padding:20px;color:#888'><p>Rendering tailored CV…</p></body></html>"); } catch { /* ignore */ }
    }
    setCvPreviewing(true);
    setActionError(null);
    try {
      const { markdown, contactDetails } = await loadCvInputs(row.tailored_cv_storage_path);
      const pdfBlob = await renderTailoredCvBlob({ markdown, contactDetails });
      const how = presentBlob(win, pdfBlob, "tailored-cv.pdf");
      if (how === "download") setActionError("Popups are blocked, so the CV was downloaded instead.");
    } catch (e) {
      try { win?.close(); } catch { /* ignore */ }
      setActionError(e instanceof Error ? e.message : "CV preview failed");
    } finally { setCvPreviewing(false); }
  }

  async function handleDownloadZip() {
    if (zipping) return;
    setActionError(null);
    setZipping(true);
    try {
      if (!row.tailored_cv_storage_path) throw new Error("Tailored CV is not available");
      if (!row.letter_id) throw new Error("No cover letter for this job");
      await downloadApplicationBundle({
        jobId: row.job_id, letterId: row.letter_id, cvStoragePath: row.tailored_cv_storage_path,
        companyName: row.job_company, hiringManager: row.job_hiring_manager });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to download ZIP bundle");
    } finally { setZipping(false); }
  }

  function handleArchive() {
    startTransition(async () => {
      try { await markJobDismissed(row.job_id, row.profile_id); }
      catch (e) { console.error(e); setActionError("Failed to archive"); return; }
      setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 400);
    });
  }

  function handleMoveBackToPool() {
    if (movingBack) return;
    setMovingBack(true);
    setActionError(null);
    startTransition(async () => {
      try {
        await markJobUnapplied(row.job_id, row.profile_id);
        setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 400);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to move back to pool");
        setMovingBack(false);
      }
    });
  }

  if (hidden) return null;

  return (
    <div className="bg-surface border border-border rounded-md p-4 anim-in">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <a href={row.job_url} target="_blank" rel="noopener noreferrer"
              className="text-title font-semibold text-text hover:text-[var(--brand)] transition-colors">
              {row.job_title}
            </a>
            {isApplied && <Badge variant="green" className="text-micro px-1.5 h-4 font-bold">Applied</Badge>}
            {isArchived && <Badge variant="gray" className="text-micro px-1.5 h-4 font-bold">Archived</Badge>}
          </div>
          <p className="text-label text-text-2 truncate mt-0.5">
            {row.job_company || "—"}{row.job_location && ` · ${row.job_location}`}{row.profile_name && ` · via ${row.profile_name}`}
          </p>
          <p className="text-caption text-text-3 mt-1 flex items-center gap-1.5">
            {isApplied
              ? <><CheckCircle2 className="w-3 h-3 text-emerald-600" /> {row.job_contact_email ? `Emailed ${row.job_contact_email}` : "Applied via job link"} · {relativeDate(row.job_applied_at)}</>
              : <><Archive className="w-3 h-3" /> Dismissed · {relativeDate(row.job_dismissed_at)}</>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lead font-bold tabular-nums ${scoreColor(row.tailored_match_score)}`}>
            {row.tailored_match_score == null ? "—" : Math.round(row.tailored_match_score)}
            {row.tailored_match_score != null && <span className="text-micro text-text-3 font-medium">/100</span>}
          </p>
        </div>
      </div>

      {actionError && <div className="mt-2"><ErrorBanner message={actionError} /></div>}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {row.letter_id && (
          <Button onClick={() => setShowEmail(true)} size="xs" icon={<Mail className="w-3 h-3" />}
            title="View the email message">
            Email message
          </Button>
        )}
        {row.letter_id && (
          <Button asChild variant="default" size="xs">
            <a href={`/api/applications/${row.letter_id}/cover-letter-pdf`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1">
              <FileType className="w-3 h-3" /> Cover letter
            </a>
          </Button>
        )}
        {row.tailored_cv_storage_path && (
          cvPdf.url
            ? <TailoredCvButton cvPdf={cvPdf} />
            : (
              <Button onClick={previewTailoredCv} disabled={cvPreviewing} isLoading={cvPreviewing}
                size="xs"
                icon={<FileText className="w-3 h-3" />}
                title="Open tailored CV PDF in new tab">
                Tailored CV
              </Button>
            )
        )}
        {row.tailored_cv_storage_path && row.letter_id && (
          <Button onClick={handleDownloadZip} disabled={zipping} isLoading={zipping}
            size="xs"
            icon={<Download className="w-3 h-3" />}>
            Download ZIP
          </Button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {isApplied && (
            <button onClick={handleMoveBackToPool} disabled={movingBack}
              className="inline-flex items-center gap-1 text-caption text-text-3 hover:text-text px-2.5 py-1 transition-colors disabled:opacity-40"
              title="Didn't actually apply? Move it back to the pool">
              {movingBack ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronRight className="w-3 h-3 rotate-180" />}
              Move back to pool
            </button>
          )}
          {isApplied && (
            <button onClick={handleArchive}
              className="inline-flex items-center gap-1 text-caption text-text-3 hover:text-text px-2.5 py-1 transition-colors">
              <Archive className="w-3 h-3" /> Archive
            </button>
          )}
        </div>
      </div>

      {showEmail && row.letter_id && (
        <SentEmailModal letterId={row.letter_id} jobLabel={`${row.job_title}${row.job_company ? ` @ ${row.job_company}` : ""}`} onClose={() => setShowEmail(false)} />
      )}
    </div>
  );
}
