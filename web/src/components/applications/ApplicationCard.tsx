"use client";

import { useState, useTransition, useRef } from "react";
import Link from "next/link";
import { ExternalLink, FileText, Mail, CheckCircle2, Archive, Loader2, Send, FileType, Pencil } from "lucide-react";
import { markJobApplied, markJobDismissed, markPoolDecision } from "@/lib/actions";
import { EditLetterModal } from "./EditLetterModal";
import { ComposeEmailModal } from "./ComposeEmailModal";

export interface ApplicationRow {
  letter_id:                 string;
  letter_completed_at:       string | null;
  letter_preview:            string;
  job_id:                    string;
  job_title:                 string;
  job_company:               string;
  job_location:              string;
  job_url:                   string;
  job_applied_at:            string | null;
  job_dismissed_at:          string | null;
  job_contact_email:         string | null;
  job_has_email:             boolean;
  job_pool_decision_at:      string | null;
  job_hiring_manager:        string | null;
  profile_id:                string;
  profile_name:              string;
  latest_run_id:             string | null;
  tailored_match_score:      number | null;
  tailored_pdf_storage_path: string | null;
}

function formatScore(n: number | null) {
  if (n == null) return "—";
  return `${Math.round(n)}`;
}

function relativeDate(d: string | null) {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function ApplicationCard({ row, isPool = false }: { row: ApplicationRow; isPool?: boolean }) {
  const [, startTransition]  = useTransition();
  const [pending, setPending]     = useState<"apply" | "archive" | "pool" | "send" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing]     = useState(false);
  const [composing, setComposing] = useState(false);
  const [localApplied, setLocalApplied]   = useState(!!row.job_applied_at);
  const [localArchived, setLocalArchived] = useState(!!row.job_dismissed_at);
  const [hidden, setHidden] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);

  const score        = formatScore(row.tailored_match_score);
  const analysisHref = row.latest_run_id
    ? `/dashboard/jobs/${row.job_id}/analyze/${row.latest_run_id}`
    : null;

  function handleApply() {
    if (localApplied || pending) return;
    setPending("apply");
    setLocalApplied(true);
    setTimeout(() => setHidden(true), 700);
    startTransition(async () => {
      try { await markJobApplied(row.job_id, row.profile_id); }
      catch (e) { console.error(e); setLocalApplied(false); setHidden(false); }
      finally   { setPending(null); }
    });
  }

  function handleArchive() {
    if (localArchived || pending) return;
    setPending("archive");
    setLocalArchived(true);
    setTimeout(() => setHidden(true), 450);
    startTransition(async () => {
      try { await markJobDismissed(row.job_id, row.profile_id); }
      catch (e) { console.error(e); setLocalArchived(false); setHidden(false); }
      finally   { setPending(null); }
    });
  }

  function handlePoolDecision(email?: string) {
    if (pending) return;
    setActionError(null);
    setPending("pool");
    startTransition(async () => {
      try {
        await markPoolDecision(row.job_id, row.profile_id, email);
        // Success — slide the card out of the pool tab
        setTimeout(() => setHidden(true), 300);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to save decision";
        setActionError(msg);
      } finally {
        setPending(null);
      }
    });
  }

  function openCompose() {
    if (pending) return;
    setActionError(null);
    setComposing(true);
  }

  function handleSent() {
    // Compose modal already posted successfully — close it and slide the card out.
    setComposing(false);
    setLocalApplied(true);
    setTimeout(() => setHidden(true), 700);
  }

  if (hidden) return null;

  return (
    <div className="bg-surface border border-border rounded-md p-4 anim-in hover:border-[var(--text-3)] transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={row.job_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] font-semibold text-text hover:text-[var(--brand)] transition-colors"
            >
              {row.job_title}
            </a>
            <ExternalLink className="w-3 h-3 text-text-3 shrink-0" />
            {localApplied && (
              <span className="badge badge-green text-[10px] px-1.5 h-4 font-bold">Applied</span>
            )}
            {localArchived && !localApplied && (
              <span className="badge badge-gray text-[10px] px-1.5 h-4 font-bold">Archived</span>
            )}
          </div>
          <p className="text-[12px] text-text-2 truncate mt-0.5">
            {row.job_company || "—"}{row.job_location && ` · ${row.job_location}`}{row.profile_name && ` · via ${row.profile_name}`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase tracking-wider text-text-3">Tailored score</p>
          <p className={`text-[18px] font-bold tabular-nums ${
            row.tailored_match_score == null
              ? "text-text-3"
              : row.tailored_match_score >= 75
              ? "text-emerald-600"
              : row.tailored_match_score >= 55
              ? "text-amber-600"
              : "text-red-600"
          }`}>
            {score}{score !== "—" && <span className="text-[12px] text-text-3 font-medium ml-0.5">/100</span>}
          </p>
        </div>
      </div>

      {/* Letter preview */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-1">Cover letter</p>
        <p className="text-[12px] text-text-2 leading-relaxed line-clamp-2">
          {row.letter_preview || "(empty letter)"}
        </p>
        <p className="text-[10px] text-text-3 mt-1">
          Generated {relativeDate(row.letter_completed_at) ?? "—"}
        </p>
      </div>

      {/* Pool decision — only shown in the "To review" tab */}
      {isPool ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800 px-3 py-2.5 mb-3">
          <p className="text-[12px] font-medium text-amber-800 dark:text-amber-300 mb-2">
            Does this job have a contact email?
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={emailRef}
              type="email"
              placeholder="recruiter@company.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && emailInput.trim()) handlePoolDecision(emailInput.trim());
              }}
              className="flex-1 text-[12px] px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
            />
            <button
              onClick={() => handlePoolDecision(emailInput.trim() || undefined)}
              disabled={pending !== null}
              className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1.5 disabled:opacity-40 shrink-0"
            >
              {pending === "pool" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              {emailInput.trim() ? "Add email" : "No email"}
            </button>
          </div>
          <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1.5">
            Add an email to move it to "Ready to email", or click "No email" to queue it for manual application.
          </p>
        </div>
      ) : (
        /* Channel ribbon for non-pool tabs */
        row.job_has_email && row.job_contact_email ? (
          <div className="flex items-center gap-1.5 mb-3 text-[12px] text-text-2">
            <Mail className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />
            <span className="font-medium">To:</span>
            <span className="font-mono text-[11px] truncate">{row.job_contact_email}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 mb-3 text-[12px] text-text-3">
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            <span>No email on file — apply via the job link</span>
          </div>
        )
      )}

      {/* Action error (pool decision or send) */}
      {actionError && (
        <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2 mb-3">
          <p className="text-[12px] text-red-700 dark:text-red-400">{actionError}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {analysisHref && (
          <Link
            href={analysisHref}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
          >
            <FileText className="w-3 h-3" />
            Full Analysis
          </Link>
        )}
        <a
          href={row.job_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
        >
          <ExternalLink className="w-3 h-3" />
          Open job
        </a>
        <a
          href={`/api/applications/${row.letter_id}/cover-letter-pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
          title="Preview cover letter PDF"
        >
          <FileType className="w-3 h-3" />
          Cover Letter
        </a>
        {/* NOTE: no "Tailored CV" preview button here on purpose. The CV PDF
            shown on the analysis page is rendered CLIENT-side by
            TailoredCvCard (markdown + current contact details + html2pdf),
            while tailored_pdf_storage_path on analysis_runs is the legacy
            server-rendered PDF from cv-backend with different layout +
            frozen contact details. Until those two paths are unified,
            previewing the server PDF here would mislead users. */}
        {/* Edit letter — visible on all non-sent cards. Server blocks edits to
            already-sent letters; hiding the button on Sent/Archived avoids
            inviting that error path. */}
        {!localApplied && !row.job_applied_at && !row.job_dismissed_at && (
          <button
            onClick={() => setEditing(true)}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
            title="Edit cover letter body"
          >
            <Pencil className="w-3 h-3" />
            Edit Letter
          </button>
        )}
        {/* Send email — opens the compose/review modal first; nothing is sent
            until the user confirms inside the modal. */}
        {!isPool && !localApplied && row.job_contact_email && (
          <button
            onClick={openCompose}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 disabled:opacity-40"
          >
            <Send className="w-3 h-3" />
            Send email
          </button>
        )}
        {!isPool && !localApplied && (
          <button
            onClick={handleApply}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
          >
            {pending === "apply" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Mark applied
          </button>
        )}
        {!isPool && !localArchived && (
          <button
            onClick={handleArchive}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40"
          >
            {pending === "archive" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
            Archive
          </button>
        )}
        {isPool && (
          <button
            onClick={handleArchive}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40 ml-auto"
          >
            {pending === "archive" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
            Dismiss
          </button>
        )}
      </div>

      {editing && (
        <EditLetterModal letterId={row.letter_id} onClose={() => setEditing(false)} />
      )}
      {composing && (
        <ComposeEmailModal
          letterId={row.letter_id}
          jobLabel={`${row.job_title}${row.job_company ? ` @ ${row.job_company}` : ""}`}
          onClose={() => setComposing(false)}
          onSent={handleSent}
        />
      )}
    </div>
  );
}
