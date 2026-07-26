"use client";

/**
 * Apply popup — what "Apply now" in the detail pane opens instead of silently
 * punting the user to the job site.
 *
 * Three ways to apply, picked from what's actually on file for this job:
 *
 *   contact email + drafted message → send it from here, CV and cover letter
 *                                     attached (POST …/send-email, which also
 *                                     stamps jobs.applied_at server-side).
 *   drafted message, no email       → the message is there to copy, plus an
 *                                     inline "+ Add email" that unlocks the
 *                                     send path (PATCH /api/jobs/[id]).
 *   neither                         → open the listing and mark it applied.
 *
 * Applying via the listing stays available in every branch: an email address on
 * file doesn't mean email is the right channel for that employer.
 *
 * Endpoints and copy are shared with the More tab (see MoreTab's EmailSection);
 * the card's shape follows AnalysisProgressModal so the two popups read as one
 * family.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Loader2, CheckCircle2, X, Mail, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui";
import { markJobApplied } from "@/lib/actions/jobs";
import type { BoardJob } from "../../lib/jobFilters";

interface EmailDraft {
  to: string;
  to_email: string | null;
  subject: string;
  body: string;
}

/** Mirrors AnalysisProgressModal — `document` doesn't exist during the server
 *  render of a client component, and useSyncExternalStore is the lint-clean way
 *  to ask "am I on the client?" without a setState-in-effect. */
const subscribeNoop = () => () => {};

export function ApplyModal({
  job, letterId, onClose, onApplied,
}: {
  job: BoardJob;
  /** Cover letter for this job's latest run, when one exists. Null while the
   *  pane's payload is still in flight — see `awaitingLetter` below. */
  letterId: string | null;
  onClose: () => void;
  /** Fired once the job is marked applied, so the pane and the board catch up. */
  onApplied: () => void;
}) {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [showAddEmail, setShowAddEmail] = useState(false);
  const [emailInput, setEmailInput]     = useState(job.contact_email ?? "");
  const [savingEmail, setSavingEmail]   = useState(false);
  const [emailError, setEmailError]     = useState<string | null>(null);

  const [draft, setDraft]         = useState<EmailDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [busy, setBusy]     = useState<null | "email" | "source">(null);
  const [error, setError]   = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Set once the job is applied — the card flips to the success view. */
  const [done, setDone] = useState<null | { via: "email"; to: string } | { via: "source" }>(null);

  // The board already knows whether a cover letter exists, so we can tell
  // "no message for this job" apart from "the pane hasn't fetched it yet"
  // rather than flashing the wrong branch.
  const awaitingLetter = !letterId && job.progress.has_cover_letter;

  useEffect(() => {
    if (!letterId) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/applications/${letterId}/email-draft`);
        if (!active) return;
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setDraftError(j.error ?? "Could not load the drafted message");
          return;
        }
        const json = await res.json();
        setDraft({ to: json.to, to_email: json.to_email, subject: json.subject, body: json.body });
      } catch (e) {
        if (active) setDraftError(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => { active = false; };
  }, [letterId]);

  async function saveEmail() {
    const trimmed = emailInput.trim();
    if (!trimmed || savingEmail) return;
    setSavingEmail(true); setEmailError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contact_email: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Could not save this email");
      }
      setContactEmail(trimmed);
      setShowAddEmail(false);
    } catch (e) {
      setEmailError(e instanceof Error ? e.message : "Could not save this email");
    } finally {
      setSavingEmail(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.body);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (permissions, insecure origin) — the
      // message is on screen to select by hand either way.
    }
  }

  async function sendEmail() {
    if (busy || !letterId || !contactEmail) return;
    setBusy("email"); setError(null);
    try {
      const res = await fetch(`/api/applications/${letterId}/send-email`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Send failed (${res.status})`);
      }
      // send-email stamps jobs.applied_at itself, so there's nothing to mark.
      setDone({ via: "email", to: contactEmail });
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the email");
    } finally {
      setBusy(null);
    }
  }

  async function applyViaSource() {
    if (busy) return;
    setBusy("source"); setError(null);
    // Opened before the await so it counts as part of the click gesture —
    // popup blockers reject a window.open that comes after one.
    window.open(job.url, "_blank", "noopener,noreferrer");
    try {
      await markJobApplied(job.id, job.profile_id);
      setDone({ via: "source" });
      onApplied();
    } catch {
      setError("Opened the listing, but couldn't mark this job as applied.");
    } finally {
      setBusy(null);
    }
  }

  if (!mounted) return null;

  const canSend = !!letterId && !!contactEmail && !!draft;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Apply for this job"
        className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl max-h-[85vh] overflow-y-auto"
      >
        <Button
          variant="default"
          size="sm"
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full p-1.5"
        >
          <X className="h-4 w-4" />
        </Button>

        {done ? (
          <SuccessCard job={job} done={done} onClose={onClose} />
        ) : (
          <>
            <div className="flex flex-col items-center text-center pt-3">
              <Mail className="h-10 w-10 text-[var(--brand)]" aria-hidden />
              <p className="mt-3 text-lead font-semibold text-text">Apply for this job</p>
              <p className="mt-1 text-body text-text-2 line-clamp-2">
                {job.title} · {job.company}
              </p>
            </div>

            <div className="mt-5 space-y-4 text-left">
              {/* ── recipient ─────────────────────────────────────────── */}
              {contactEmail ? (
                <div className="flex items-center gap-2 text-label flex-wrap">
                  <span className="text-text-3">To:</span>
                  <span className="font-semibold text-text break-all">{contactEmail}</span>
                  <button
                    type="button"
                    onClick={() => { setShowAddEmail((v) => !v); setEmailError(null); }}
                    className="text-[var(--brand)] hover:underline font-medium"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="rounded-[10px] bg-[#f7f8fa] border border-border px-3.5 py-2.5 text-body text-text-2">
                  <b className="text-text">No contact email on file</b> for this listing — apply
                  on {job.source} instead, or add an address if you find one.
                </div>
              )}

              {!contactEmail && !showAddEmail && (
                <Button size="sm" onClick={() => setShowAddEmail(true)}>+ Add email</Button>
              )}

              {showAddEmail && (
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="contact@company.com"
                    className="field text-label py-1.5 flex-1 min-w-0"
                  />
                  <Button variant="brand" size="sm" onClick={saveEmail} disabled={savingEmail || !emailInput.trim()}>
                    {savingEmail ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
                  </Button>
                </div>
              )}
              {emailError && <p className="text-label text-red-600">{emailError}</p>}

              {/* ── drafted message ───────────────────────────────────── */}
              {(awaitingLetter || (letterId && !draft)) && !draftError && (
                <p className="flex items-center gap-2 text-label text-text-3">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your drafted message…
                </p>
              )}
              {draftError && <p className="text-label text-red-600">{draftError}</p>}
              {draft && (
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-caption uppercase tracking-wide font-bold text-text">
                      Your message
                    </span>
                    <Button size="xs" className="ml-auto" onClick={copyDraft}>
                      {copied ? "Copied ✓" : "Copy"}
                    </Button>
                  </div>
                  <div className="rounded-[10px] border border-border bg-[#fafbfc] px-4 py-3 max-h-[180px] overflow-y-auto">
                    <p className="text-label text-text whitespace-pre-wrap leading-relaxed">{draft.body}</p>
                  </div>
                  <p className="mt-1.5 text-caption text-text-3">
                    {contactEmail
                      ? "Your tailored CV and cover letter go out as attachments."
                      : "Copy this into your own email — the CV and cover letter are on the More tab."}
                  </p>
                </div>
              )}

              {!letterId && !awaitingLetter && (
                <p className="text-label text-text-3">
                  No cover letter has been generated for this job, so there&apos;s no message to
                  send — apply on the listing instead.
                </p>
              )}
            </div>

            {error && <p className="mt-3 text-label text-red-600">{error}</p>}

            {/* ── actions ─────────────────────────────────────────────── */}
            <div className="mt-5 flex flex-col gap-2">
              {canSend && (
                <button
                  type="button"
                  onClick={sendEmail}
                  disabled={!!busy}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] py-2 text-body font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "email"
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Mail className="h-4 w-4" />}
                  {busy === "email" ? "Sending…" : "Send application email"}
                </button>
              )}
              <button
                type="button"
                onClick={applyViaSource}
                disabled={!!busy}
                className={
                  canSend
                    ? "inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-[var(--border)] py-2 text-body font-medium text-text transition-colors hover:bg-[var(--bg)] disabled:opacity-50"
                    : "inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] py-2 text-body font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
                }
              >
                {busy === "source"
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <ExternalLink className="h-4 w-4" />}
                {busy === "source"
                  ? "Opening…"
                  : canSend ? `Apply on ${job.source} instead` : `Apply on ${job.source}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function SuccessCard({
  job, done, onClose,
}: {
  job: BoardJob;
  done: { via: "email"; to: string } | { via: "source" };
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center pt-3">
      <CheckCircle2 className="h-10 w-10 text-green-500" aria-hidden />
      <p className="mt-3 text-lead font-semibold text-text" aria-live="polite">
        {done.via === "email" ? "Application sent" : "Marked as applied"}
      </p>
      <p className="mt-1 text-body text-text-2 line-clamp-2">
        {job.title} · {job.company}
      </p>
      <p className="mt-3 text-label text-text-2">
        {done.via === "email" ? (
          <>
            Sent to <b className="text-text break-all">{done.to}</b> with your tailored CV and
            cover letter attached. This job now sits in your Applied pile.
          </>
        ) : (
          <>
            The listing is open in a new tab — finish the application there. We&apos;ve moved this
            job to your Applied pile so you can track it.
          </>
        )}
      </p>
      <Button
        variant="default"
        size="sm"
        type="button"
        onClick={onClose}
        className="mt-5 w-full rounded-full py-2 text-body font-medium"
      >
        Close
      </Button>
    </div>
  );
}
