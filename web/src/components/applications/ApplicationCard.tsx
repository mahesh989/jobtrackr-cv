"use client";

import { useState, useTransition, useRef } from "react";
import Link from "next/link";
import { ExternalLink, FileText, Mail, CheckCircle2, Archive, Loader2, Send, FileType, Pencil, Copy, Check } from "lucide-react";
import { markJobApplied, markJobDismissed, markPoolDecision } from "@/lib/actions";
import { EditLetterModal } from "./EditLetterModal";
import { ComposeEmailModal } from "./ComposeEmailModal";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { renderTailoredCvBlob } from "@/lib/cvPdfRender";
import type { ContactDetails } from "@/lib/cvMarkdownHelpers";

export interface ApplicationRow {
  letter_id:                 string;
  letter_completed_at:       string | null;
  letter_preview:            string;
  letter_reviewed_at:        string | null;
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
  tailored_cv_storage_path:  string | null;
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

/**
 * Copy text to the clipboard with a graceful fallback.
 *
 * navigator.clipboard.writeText is the modern API but throws
 * "NotAllowedError" in several real-world situations even on HTTPS with a
 * legitimate user gesture: Safari with the page out of focus, in-app
 * browsers (Instagram / FB / Slack), certain extensions, and Chrome when
 * the iframe permissions policy is restrictive. When that happens we fall
 * back to the deprecated-but-universally-supported execCommand path via a
 * hidden textarea. Returns true on success.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  // Modern path. May reject for the reasons above — swallow and try fallback.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand
    }
  }
  // Legacy path. Works in every browser that has document.execCommand.
  try {
    const ta = document.createElement("textarea");
    ta.value          = text;
    ta.style.position = "fixed";
    ta.style.opacity  = "0";
    ta.style.left     = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export type CardTab = "pool" | "email" | "apply" | "sent" | "archived";

export function ApplicationCard({
  row,
  tab = "apply",
  isPool = false,
}: {
  row:     ApplicationRow;
  tab?:    CardTab;
  /** @deprecated kept for callers that haven't migrated; equivalent to tab="pool" */
  isPool?: boolean;
}) {
  // Back-compat: callers that set isPool=true override the tab.
  const currentTab: CardTab = isPool ? "pool" : tab;
  const [, startTransition]  = useTransition();
  const [pending, setPending]     = useState<"apply" | "archive" | "pool" | "send" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing]     = useState(false);
  const [composing, setComposing] = useState(false);
  const [cvPreviewing, setCvPreviewing] = useState(false);
  const [localApplied, setLocalApplied]   = useState(!!row.job_applied_at);
  const [localReviewed, setLocalReviewed] = useState(!!row.letter_reviewed_at);
  const [copied, setCopied] = useState(false);
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

  async function previewTailoredCv() {
    if (cvPreviewing || !row.tailored_cv_storage_path) return;
    setActionError(null);
    setCvPreviewing(true);
    try {
      const supabase = createSupabaseClient();
      const [{ data: mdBlob, error: dlErr }, prefsRes] = await Promise.all([
        supabase.storage.from("tailored-cvs").download(row.tailored_cv_storage_path),
        fetch("/api/user/preferences"),
      ]);
      if (dlErr || !mdBlob) throw new Error(dlErr?.message ?? "Couldn't load CV markdown");
      const markdown = await mdBlob.text();
      let contactDetails: ContactDetails | null = null;
      if (prefsRes.ok) {
        const json = await prefsRes.json();
        if (json?.contact_details) {
          const cd = { ...json.contact_details };
          delete cd.projects;
          contactDetails = cd as ContactDetails;
        }
      }
      const pdfBlob = await renderTailoredCvBlob({ markdown, contactDetails });
      const url = URL.createObjectURL(pdfBlob);
      window.open(url, "_blank", "noopener,noreferrer");
      // Revoke after a delay so the new tab has time to read the URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "CV preview failed");
    } finally {
      setCvPreviewing(false);
    }
  }

  function handleReviewed() {
    // Review modal stamped reviewed_at + saved subject/body. The card now
    // belongs to the next stage (Ready to apply); slide it out of this tab.
    setComposing(false);
    setLocalReviewed(true);
    setTimeout(() => setHidden(true), 500);
  }

  function handleSent() {
    // Compose modal already posted successfully — close it and slide the card out.
    setComposing(false);
    setLocalApplied(true);
    setTimeout(() => setHidden(true), 700);
  }

  // Direct send — no modal — used by the Send button in the "Ready to apply"
  // tab on reviewed email-channel cards. The CV is rendered fresh client-side
  // so the attachment matches what users previewed.
  async function handleDirectSend() {
    if (pending) return;
    if (!row.tailored_cv_storage_path) {
      // No CV markdown to render — fall back to the compose modal which has
      // the legacy server-PDF fallback baked in.
      openCompose();
      return;
    }
    setActionError(null);
    setPending("send");
    try {
      const supabase = createSupabaseClient();
      const [{ data: mdBlob, error: mdErr }, prefsRes] = await Promise.all([
        supabase.storage.from("tailored-cvs").download(row.tailored_cv_storage_path),
        fetch("/api/user/preferences"),
      ]);
      if (mdErr || !mdBlob) throw new Error(mdErr?.message ?? "Couldn't load CV markdown");
      const markdown = await mdBlob.text();
      let contactDetails: ContactDetails | null = null;
      if (prefsRes.ok) {
        const json = await prefsRes.json();
        if (json?.contact_details) {
          const cd = { ...json.contact_details };
          delete cd.projects;
          contactDetails = cd as ContactDetails;
        }
      }
      const pdfBlob = await renderTailoredCvBlob({ markdown, contactDetails });

      const form = new FormData();
      const slug = (row.job_company || "company").replace(/[^a-zA-Z0-9]/g, "_");
      form.set("cv_pdf", pdfBlob, `TailoredCV_${slug}.pdf`);
      // No subject/body override — /send-email reads the approved values
      // from cover_letters.email_subject/email_body (set during review).

      const res  = await fetch(`/api/applications/${row.letter_id}/send-email`, {
        method: "POST",
        body:   form,
      });
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? "Send failed"); return; }
      setLocalApplied(true);
      setTimeout(() => setHidden(true), 700);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Network error");
    } finally {
      setPending(null);
    }
  }

  function handleApplyNow() {
    if (pending || localApplied) return;
    // Open the job posting first — window.open MUST be called synchronously
    // from the user gesture, otherwise the popup blocker swallows it.
    window.open(row.job_url, "_blank", "noopener,noreferrer");
    // Then mark applied. handleApply does the optimistic UI + server action
    // + slides the card out toward the Sent/Applied tab.
    handleApply();
  }

  async function handleCopyEmail() {
    if (copied || pending) return;
    setActionError(null);
    try {
      // Pull the approved subject + body via the same endpoint the modal uses,
      // so users see exactly what they approved (not whatever the default is now).
      const res  = await fetch(`/api/applications/${row.letter_id}/email-draft`);
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? "Could not load draft"); return; }
      const subject = json.subject ?? "";
      const body    = json.body    ?? "";
      // Clipboard payload: Subject: ... / blank / body. Plain text is what
      // most users want when pasting into Gmail / Outlook / Apple Mail.
      const payload = `Subject: ${subject}\n\n${body}`;

      const ok = await copyToClipboard(payload);
      if (!ok) {
        setActionError("Couldn't access the clipboard automatically — open the email in the Review modal and copy from there.");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Copy failed");
    }
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

      {/* Cover letter freshness line — full preview is one click away via the
          Cover Letter PDF button, so the truncated snippet is removed. */}
      <p className="text-[11px] text-text-3 mb-3">
        Cover letter generated {relativeDate(row.letter_completed_at) ?? "—"}
      </p>

      {/* Pool decision — only shown in the "Application pool" tab. The flow is the
          same regardless of whether the job has a contact email; the email
          field is optional and just gets saved to jobs.contact_email if filled.
          When sending is later attempted from Ready to apply, the presence of
          contact_email decides Send-vs-Copy. */}
      {currentTab === "pool" ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800 px-3 py-2.5 mb-3">
          <p className="text-[12px] font-medium text-amber-800 dark:text-amber-300 mb-2">
            Queue this for review?
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={emailRef}
              type="email"
              placeholder="Contact email (optional)"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePoolDecision(emailInput.trim() || undefined);
              }}
              className="flex-1 text-[12px] px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
            />
            <button
              onClick={() => handlePoolDecision(emailInput.trim() || undefined)}
              disabled={pending !== null}
              className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1.5 disabled:opacity-40 shrink-0"
            >
              {pending === "pool" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Queue for review
            </button>
          </div>
          <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1.5">
            Adding an email enables one-click send later. Leave it blank to draft the email anyway — you'll be able to copy it for your own client.
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
            <span>No contact email — you'll copy the draft and apply via the job link</span>
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
        {/* Tailored CV preview — renders client-side using the same pipeline
            as the analysis page Download PDF button, so what users preview
            here matches what the recipient receives as an attachment. */}
        {row.tailored_cv_storage_path && (
          <button
            type="button"
            onClick={previewTailoredCv}
            disabled={cvPreviewing}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
            title="Preview tailored CV PDF (renders in your browser, ~1-2s)"
          >
            {cvPreviewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileType className="w-3 h-3" />}
            {cvPreviewing ? "Rendering…" : "Tailored CV"}
          </button>
        )}
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
            Edit cover letter
          </button>
        )}
        {/* Review (Ready to review tab) — opens the compose modal in review
            mode. Available for ALL cards in this stage, whether or not a
            contact email is on file. Approval saves subject/body +
            reviewed_at; nothing is sent here. */}
        {currentTab === "email" && !localApplied && !localReviewed && (
          <button
            onClick={openCompose}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 disabled:opacity-40"
          >
            <Send className="w-3 h-3" />
            Review
          </button>
        )}

        {/* Send email (Ready to apply, reviewed cards WITH a contact email) —
            dispatches directly without re-opening the modal. */}
        {currentTab === "apply" && !localApplied && row.job_contact_email && (
          <button
            onClick={handleDirectSend}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 disabled:opacity-40"
            title="Send the approved email — renders CV PDF then dispatches"
          >
            {pending === "send" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {pending === "send" ? "Sending…" : "Send email"}
          </button>
        )}

        {/* Copy email (Ready to apply, no contact email) — copies the
            approved subject + body to clipboard so the user can paste into
            their own client. */}
        {currentTab === "apply" && !localApplied && !row.job_contact_email && (
          <button
            onClick={handleCopyEmail}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 disabled:opacity-40"
            title="Copy the approved subject + body to your clipboard"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied" : "Copy email"}
          </button>
        )}

        {/* Apply now (Ready to apply) — opens the job posting in a new tab
            AND marks the job applied so the card slides over to Sent/Applied.
            Shown for both email and no-email cards: it's always useful to
            jump to the listing. window.open is called synchronously inside
            the click handler so popup blockers don't eat it. */}
        {currentTab === "apply" && !localApplied && (
          <button
            type="button"
            onClick={handleApplyNow}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
            title="Open the job posting and mark this application as applied"
          >
            <ExternalLink className="w-3 h-3" />
            Apply now
          </button>
        )}

        {/* Mark applied — available on apply, email (rare), and other non-pool tabs */}
        {currentTab !== "pool" && !localApplied && (
          <button
            onClick={handleApply}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
          >
            {pending === "apply" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Mark applied
          </button>
        )}
        {currentTab !== "pool" && !localArchived && (
          <button
            onClick={handleArchive}
            disabled={pending !== null}
            className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40"
          >
            {pending === "archive" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
            Archive
          </button>
        )}
        {currentTab === "pool" && (
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
          mode={currentTab === "email" ? "review" : "send"}
          onClose={() => setComposing(false)}
          onSent={handleSent}
          onReviewed={handleReviewed}
        />
      )}
    </div>
  );
}
