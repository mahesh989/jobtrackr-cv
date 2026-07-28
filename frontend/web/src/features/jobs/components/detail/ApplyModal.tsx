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
 *   no cover letter at all          → a "Write my cover letter" button. Below
 *                                     the final gate is the ONLY reason a job
 *                                     reaches this branch (the pipeline skips
 *                                     cover-letter generation there unless
 *                                     forced — see statusSubtext's "cover
 *                                     letter skipped" in DetailHeader), so
 *                                     "Apply anyway" generating one anyway is
 *                                     the button living up to its name. One
 *                                     click runs the whole thing — generate
 *                                     opening variants, auto-pick the first
 *                                     (no picking UI exists in this board yet;
 *                                     that only lives on the full analysis
 *                                     page), then poll until the letter's
 *                                     `pass_3_final` lands — and falls through
 *                                     to the normal send/copy flow above.
 *   neither                         → open the listing and mark it applied.
 *
 * Applying via the listing stays available in every branch: an email address on
 * file doesn't mean email is the right channel for that employer.
 *
 * Marking "applied" from here goes through PATCH /api/jobs/[id] rather than
 * the `markJobApplied` server action the card list uses — that action calls
 * revalidatePath, which triggers Next's implicit route refresh the instant a
 * server action resolves. On the board's own page that refetches the whole
 * server-rendered list and resets its scroll to the top right as this popup's
 * success card appears — exactly the "why did it jump" bug this pane exists to
 * avoid. An API route has no such side effect.
 *
 * Layout is two columns: the drafted message on the left in EVERY state, the
 * action for the current state on the right. The message used to live in a
 * branch that the confirm card replaced wholesale, so clicking "Apply on
 * {source}" took it off screen at precisely the moment the user had the
 * employer's form open and wanted to paste it.
 *
 * The message's durable home is the Cover letter tab — this popup only shows a
 * copy of it, so nothing here is the last chance to grab it.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Loader2, CheckCircle2, X, Mail, ExternalLink, PenLine } from "lucide-react";
import { Button } from "@/components/ui";
import type { BoardJob } from "../../lib/jobFilters";

interface EmailDraft {
  to: string;
  to_email: string | null;
  subject: string;
  body: string;
}

/** Generation is a one-shot AI cost, so it polls rather than subscribing —
 *  simpler than wiring a Realtime channel for something this pane only ever
 *  waits on once. cv-backend writes P2-4 as a background task after `pick`. */
const GENERATE_POLL_MS   = 2000;
const GENERATE_TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mirrors AnalysisProgressModal — `document` doesn't exist during the server
 *  render of a client component, and useSyncExternalStore is the lint-clean way
 *  to ask "am I on the client?" without a setState-in-effect. */
const subscribeNoop = () => () => {};

export function ApplyModal({
  job, letterId, onClose, onApplied, onChanged,
}: {
  job: BoardJob;
  /** Cover letter for this job's latest run, when one exists. Null while the
   *  pane's payload is still in flight — see `awaitingLetter` below. */
  letterId: string | null;
  onClose: () => void;
  /** Fired once the job is marked applied, so the pane and the board catch up. */
  onApplied: () => void;
  /** Fired once a cover letter this modal generated finishes writing, so the
   *  pane refetches and picks up the new Cover letter / More tabs. Distinct
   *  from `onApplied` — generating a letter doesn't mean the job was applied
   *  to yet, the user might still back out before sending. */
  onChanged: () => void;
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
  const [done, setDone] = useState<
    null | { via: "email"; to: string } | { via: "source"; opened: boolean }
  >(null);
  /** Set once the listing has been handed off and we're waiting to hear
   *  whether the user actually went through with it. */
  const [confirmSource, setConfirmSource] = useState<null | { opened: boolean }>(null);

  // Set once this modal generates a letter itself. `letterId` (the prop) won't
  // catch up until the pane refetches its board-detail payload — this is what
  // lets the send/copy flow below activate the instant writing finishes,
  // without waiting on that round trip.
  const [localLetterId, setLocalLetterId] = useState<string | null>(null);
  const effectiveLetterId = letterId ?? localLetterId;
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  /** Company name while its research call is in flight — that leg alone can
   *  take 15-45s (Tavily + scrape + AI distill), so the progress line names it
   *  rather than leaving the user on a generic "writing…" for a minute. */
  const [researching, setResearching] = useState<string | null>(null);

  // The board already knows whether a cover letter exists, so we can tell
  // "no message for this job" apart from "the pane hasn't fetched it yet"
  // rather than flashing the wrong branch.
  const awaitingLetter = !letterId && !localLetterId && job.progress.has_cover_letter;

  useEffect(() => {
    if (!effectiveLetterId) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/applications/${effectiveLetterId}/email-draft`);
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
  }, [effectiveLetterId]);

  /** Starts generation, auto-researching the company once if that's the only
   *  thing blocking it. Mirrors CoverLetterPanel's handleGenerate on the full
   *  analysis page: a below-gate job here is often also a job whose company
   *  has never been researched (research is itself normally triggered as
   *  part of generating a letter — which below-gate jobs skip), so hitting
   *  this gate on the very first "Apply anyway" is the expected case, not a
   *  fluke. `didAutoResearch` stops it from retrying more than once. */
  async function startGeneration(didAutoResearch: boolean): Promise<string> {
    const startRes = await fetch(`/api/jobs/${job.id}/cover-letter?override=final_gate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const startJson = await startRes.json().catch(() => ({}));

    if (!startRes.ok) {
      if (startRes.status === 422 && startJson.action === "research_company") {
        // Second time through means research reported success but generation
        // still can't see a row. Repeating the raw "Company research has not
        // been run" copy here reads as though nothing was attempted, which is
        // what made this look like a dead "Try again" loop — say what actually
        // happened instead.
        if (didAutoResearch) {
          throw new Error(
            `We researched ${job.company ?? "this company"} but the result didn't save, so the ` +
            "letter still can't be written. This is a server-side problem, not something " +
            "you can fix by retrying — please report it.",
          );
        }
        setResearching(startJson.company_name ?? job.company ?? "this company");
        try {
          const researchRes = await fetch("/api/company-research", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ company_name: startJson.company_name ?? job.company }),
          });
          const rj = await researchRes.json().catch(() => ({}));
          if (!researchRes.ok) {
            throw new Error(rj.error ?? "Company research failed. Try again.");
          }
        } finally {
          setResearching(null);
        }
        return startGeneration(true);
      }
      throw new Error(startJson.error ?? `Could not start (${startRes.status})`);
    }

    const newLetterId = startJson.letter_id as string;
    if (startJson.status === "picking") {
      const variants = Array.isArray(startJson.variants) ? startJson.variants : [];
      const firstVariant = variants[0];
      if (!firstVariant?.id) throw new Error("No opening options came back — try again.");
      const pickRes = await fetch(`/api/jobs/${job.id}/cover-letter/${newLetterId}/pick`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ variant_id: firstVariant.id }),
      });
      const pickJson = await pickRes.json().catch(() => ({}));
      if (!pickRes.ok) throw new Error(pickJson.error ?? `Could not start writing (${pickRes.status})`);
    }
    // "cached" means a non-stale letter already existed and is done — the
    // poll below resolves on its first pass either way.
    return newLetterId;
  }

  /** One click runs generate (auto-researching the company first if needed)
   *  → auto-pick the first opener → poll to completion. `override=final_gate`
   *  because this only ever fires for a below-gate job (see the module doc)
   *  — the pipeline's own reason for skipping the letter in the first place,
   *  and exactly what "anyway" means. */
  async function generateCoverLetter() {
    if (generating) return;
    setGenerating(true); setGenerateError(null);
    try {
      const newLetterId = await startGeneration(false);

      const deadline = Date.now() + GENERATE_TIMEOUT_MS;
      for (;;) {
        const statusRes = await fetch(`/api/jobs/${job.id}/cover-letter/${newLetterId}`);
        if (statusRes.ok) {
          const { letter } = await statusRes.json();
          if (letter?.status === "completed") break;
          if (letter?.status === "failed") {
            throw new Error(letter?.error_message || "Generation failed — try again.");
          }
        }
        if (Date.now() > deadline) {
          throw new Error("Still writing — this is taking longer than expected. Try again shortly.");
        }
        await sleep(GENERATE_POLL_MS);
      }

      setLocalLetterId(newLetterId);
      onChanged();
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : "Could not generate a cover letter");
    } finally {
      setGenerating(false);
    }
  }

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
    if (busy || !effectiveLetterId || !contactEmail) return;
    setBusy("email"); setError(null);
    try {
      const res = await fetch(`/api/applications/${effectiveLetterId}/send-email`, { method: "POST" });
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

  /** Opens the listing and hands off — deliberately WITHOUT marking the job
   *  applied yet. We have no way to know the user actually completed the
   *  employer's form: they may hit a login wall, find the ad expired, or
   *  simply change their mind. Stamping applied_at on the click made the board
   *  assert an application that may never have happened, and undoing it means
   *  hunting the job down in the Applied pile. So the click hands off and the
   *  next card asks.
   *
   *  Asked for on the source path whether or not a contact email exists — the
   *  uncertainty is identical either way. The email path needs no such
   *  confirmation because there we did the sending ourselves. */
  function openListing() {
    if (busy) return;
    setError(null);
    // Opened synchronously so it still counts as part of the click gesture —
    // popup blockers reject a window.open issued after an await. `win` comes
    // back null when the blocker actually intervenes (Chrome/Firefox), which
    // the confirm card below reads so it can offer a manual link instead of
    // pretending a tab appeared.
    const win = window.open(job.url, "_blank", "noopener,noreferrer");
    setConfirmSource({ opened: !!win });
  }

  async function confirmApplied(opened: boolean) {
    if (busy) return;
    setBusy("source"); setError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ applied_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Failed (${res.status})`);
      }
      setDone({ via: "source", opened });
      onApplied();
    } catch {
      setError("Couldn't mark this job as applied — try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!mounted) return null;

  const canSend = !!effectiveLetterId && !!contactEmail && !!draft;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Apply for this job"
        className="relative w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl max-h-[85vh] overflow-y-auto"
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

        <div className="pr-8">
          <p className="text-lead font-semibold text-text">Apply for this job</p>
          <p className="mt-0.5 text-body text-text-2 line-clamp-2">
            {job.title} · {job.company}
          </p>
        </div>

        {/* Two columns, stacking on narrow viewports. The split exists so the
            message stays on screen through EVERY state: previously, clicking
            "Apply on {source}" swapped the whole body for the confirm card, so
            the drafted message vanished at the exact moment the user was
            standing in the listing's form wanting to paste it. */}
        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">

          {/* ── left: the message, in every state ─────────────────────── */}
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-caption uppercase tracking-wide font-bold text-text">
                Message to employer
              </span>
              {draft && (
                <Button size="xs" className="ml-auto" onClick={copyDraft}>
                  {copied ? "Copied ✓" : "Copy"}
                </Button>
              )}
            </div>

            {(awaitingLetter || (effectiveLetterId && !draft)) && !draftError && (
              <p className="flex items-center gap-2 text-label text-text-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your drafted message…
              </p>
            )}
            {draftError && <p className="text-label text-red-600">{draftError}</p>}

            {draft && (
              <div className="rounded-[10px] border border-border bg-[#fafbfc] px-4 py-3 max-h-[260px] overflow-y-auto">
                <p className="text-label text-text whitespace-pre-wrap leading-relaxed">{draft.body}</p>
              </div>
            )}

            {!effectiveLetterId && !awaitingLetter && !generating && (
              <div className="rounded-[10px] border border-dashed border-[var(--border)] px-3.5 py-3">
                <p className="text-label text-text-2">
                  No cover letter has been generated for this job yet — the ATS score didn&apos;t
                  clear the bar to write one automatically.
                </p>
                <button
                  type="button"
                  onClick={generateCoverLetter}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-3.5 py-1.5 text-label font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90"
                >
                  <PenLine className="w-3.5 h-3.5" /> Write my cover letter
                </button>
              </div>
            )}
            {generating && (
              <p className="flex items-center gap-2 text-label text-text-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {researching
                  ? `Researching ${researching} first — paragraph 2 needs a real fact about them to anchor on. This takes 15-45 seconds.`
                  : "Writing your cover letter… this can take a minute or two."}
              </p>
            )}
            {generateError && (
              <div className="rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-2.5">
                <p className="text-label text-red-600">{generateError}</p>
                <button
                  type="button"
                  onClick={generateCoverLetter}
                  className="mt-1.5 text-label font-medium text-[var(--brand)] hover:underline"
                >
                  Try again
                </button>
              </div>
            )}

            {draft && (
              <p className="mt-1.5 text-caption text-text-3">
                {contactEmail
                  ? "Your tailored CV and cover letter go out as attachments."
                  : "Copy this into your own email — get the CV and cover letter from Download above."}
              </p>
            )}
          </div>

          {/* ── right: what to do about it ────────────────────────────── */}
          <div className="min-w-0 md:border-l md:border-[var(--border)] md:pl-5">
            {done ? (
              <SuccessCard job={job} done={done} onClose={onClose} />
            ) : confirmSource ? (
              <ConfirmSourceCard
                job={job}
                opened={confirmSource.opened}
                busy={busy === "source"}
                error={error}
                onYes={() => confirmApplied(confirmSource.opened)}
                onNo={() => setConfirmSource(null)}
              />
            ) : (
              <>
                <div className="space-y-3 text-left">
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
                  {error && <p className="text-label text-red-600">{error}</p>}
                </div>

                <div className="mt-4 flex flex-col gap-2">
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
                    onClick={openListing}
                    disabled={!!busy}
                    className={
                      canSend
                        ? "inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-[var(--border)] py-2 text-body font-medium text-text transition-colors hover:bg-[var(--bg)] disabled:opacity-50"
                        : "inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] py-2 text-body font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
                    }
                  >
                    <ExternalLink className="h-4 w-4" />
                    {canSend ? `Apply on ${job.source} instead` : `Apply on ${job.source}`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <p className="mt-5 border-t border-[var(--border)] pt-3 text-caption text-text-3">
          This message is kept on the job&apos;s <b className="font-semibold text-text-2">Cover letter</b> tab —
          copy it there any time, including after you&apos;ve applied.
        </p>
      </div>
    </div>,
    document.body,
  );
}

/** The hand-off checkpoint: the listing is open, we can't see what happens
 *  there, so ask instead of assuming. "Not yet" is the safe default — the job
 *  stays exactly where it was and the popup drops back to the compose view
 *  (it used to close outright, which meant reopening Apply and re-fetching the
 *  draft just to read the message again). */
function ConfirmSourceCard({
  job, opened, busy, error, onYes, onNo,
}: {
  job: BoardJob;
  opened: boolean;
  busy: boolean;
  error: string | null;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center pt-3">
      <ExternalLink className="h-10 w-10 text-[var(--brand)]" aria-hidden />
      <p className="mt-3 text-lead font-semibold text-text">
        {opened ? `Opened on ${job.source}` : `Open this on ${job.source}`}
      </p>
      <p className="mt-1 text-body text-text-2 line-clamp-2">
        {job.title} · {job.company}
      </p>
      <p className="mt-3 text-label text-text-2">
        {opened ? (
          <>
            Finish the application in the new tab, then come back and tell us how it went — we
            won&apos;t mark it applied until you say so.
          </>
        ) : (
          <>
            Your browser blocked the new tab —{" "}
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--brand)] hover:underline"
            >
              open the listing here
            </a>
            , then come back and tell us how it went.
          </>
        )}
      </p>

      {error && <p className="mt-3 text-label text-red-600">{error}</p>}

      <div className="mt-5 flex w-full flex-col gap-2">
        <button
          type="button"
          onClick={onYes}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] py-2 text-body font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {busy ? "Saving…" : "I applied — mark it"}
        </button>
        <Button
          variant="default"
          size="sm"
          type="button"
          onClick={onNo}
          disabled={busy}
          className="w-full rounded-full py-2 text-body font-medium"
        >
          Not yet
        </Button>
      </div>
    </div>
  );
}

function SuccessCard({
  job, done, onClose,
}: {
  job: BoardJob;
  done: { via: "email"; to: string } | { via: "source"; opened: boolean };
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
        ) : done.opened ? (
          <>
            The listing is open in a new tab — finish the application there. We&apos;ve moved this
            job to your Applied pile so you can track it.
          </>
        ) : (
          <>
            Your browser blocked the listing from opening automatically —{" "}
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--brand)] hover:underline"
            >
              open it here
            </a>
            . We&apos;ve still moved this job to your Applied pile so you can track it.
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
