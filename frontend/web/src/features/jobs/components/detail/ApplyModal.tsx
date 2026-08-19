"use client";

/**
 * Apply popup — what "Apply now" / "Apply anyway" in the detail pane opens
 * instead of silently punting the user to the job site.
 *
 * Layout is two columns and both are always on screen:
 *
 *   left   the message to the employer, editable, with Copy. This is the only
 *          editor for it — the Cover letter tab holds the letter, this holds
 *          the message, and neither duplicates the other.
 *   right  BOTH ways to apply at once: send it as an email from here, or open
 *          the listing and confirm afterwards. Which one is right depends on
 *          the employer, not on what we happen to know about them, so both are
 *          offered rather than the popup guessing and hiding the other.
 *
 * Nothing here ever replaces the whole body with a different screen. An older
 * version swapped in a confirmation card after "Apply on {source}", which took
 * the message off screen at exactly the moment the user was standing in the
 * employer's form wanting to paste it.
 *
 * WHY THE MESSAGE APPEARS INSTANTLY
 * `/email-draft` re-runs an AI voice rewrite on every call for any letter the
 * user hasn't explicitly approved, which costs 15-45s. The board payload
 * already carries the stored `email_body`, so when there is one we render it
 * immediately and never call that route. Sending or copying persists the text
 * via POST /review, which stamps `reviewed_at` — from then on the route's own
 * tier-1 path trusts the stored body too.
 *
 * Marking "applied" goes through PATCH /api/jobs/[id] rather than the
 * revalidatePath-based server action the card list used to use — revalidatePath
 * refetches the whole server-rendered board and resets its scroll to the top
 * just as this popup's success card appears.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Loader2, CheckCircle2, X, Mail, ExternalLink, PenLine, Copy, Check, Link2,
} from "lucide-react";
import { Button } from "@/components/ui";
import { buildDefaultEmailDraft } from "@/lib/email/draftBody";
import { fetchEmailDraft } from "@/lib/email/emailDraft";
import { loadCvInputs } from "@/features/applications/lib/cvPdfClient";
import { renderTailoredCvBlob } from "@/lib/cv/pdfRender";
import { MAX_APPLICATION_BODY_LEN } from "@/lib/constants";
import type { BoardJob } from "../../lib/jobFilters";

/** Generation is a one-shot AI cost, so it polls rather than subscribing —
 *  simpler than wiring a Realtime channel for something this pane only ever
 *  waits on once. cv-backend writes P2-4 as a background task after `pick`. */
const GENERATE_POLL_MS    = 2000;
const GENERATE_TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mirrors AnalysisProgressModal — `document` doesn't exist during the server
 *  render of a client component, and useSyncExternalStore is the lint-clean way
 *  to ask "am I on the client?" without a setState-in-effect. */
const subscribeNoop = () => () => {};

export function ApplyModal({
  job, letterId, letterSubject = null, letterBody = null, cvStoragePath = null,
  onClose, onApplied, onChanged,
}: {
  job: BoardJob;
  /** Cover letter for this job's latest run, when one exists. Null while the
   *  pane's payload is still in flight — see `awaitingLetter` below. */
  letterId: string | null;
  /** Stored message off the board payload. When present the message renders on
   *  the first frame and `/email-draft` is never called — see the module note. */
  letterSubject?: string | null;
  letterBody?: string | null;
  /** Tailored-CV markdown path for this job's latest run. The send renders the
   *  PDF from it in the browser so the attachment is the same bytes the panel
   *  previewed — see sendEmail. */
  cvStoragePath?: string | null;
  onClose: () => void;
  /** Fired once the job is marked applied, so the pane and the board catch up. */
  onApplied: () => void;
  /** Fired once a cover letter this modal generated finishes writing, so the
   *  pane refetches and picks up the new Cover letter tab. Distinct from
   *  `onApplied` — generating a letter doesn't mean the job was applied to yet,
   *  the user might still back out before sending. */
  onChanged: () => void;
}) {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [showAddEmail, setShowAddEmail] = useState(!job.contact_email);
  const [emailInput, setEmailInput]     = useState(job.contact_email ?? "");
  const [savingEmail, setSavingEmail]   = useState(false);
  const [emailError, setEmailError]     = useState<string | null>(null);

  // Seeded straight from the board payload when it has a stored body, so the
  // message is on screen before the first paint. `subject` has no UI of its own
  // — it rides along so a send doesn't fall back to the server default.
  // A letter can have a stored body with no stored subject — that column is
  // only written once something approves a draft. Recomputing the server's own
  // default from the same helper it uses keeps the two byte-identical (see that
  // module's note) and, crucially, stops us POSTing an empty subject, which
  // would otherwise send a real email with a blank subject line.
  const defaultSubject = buildDefaultEmailDraft({
    jobTitle:      job.title,
    company:       job.company,
    hiringManager: job.hiring_manager,
    userName:      null,
  }).subject;
  const [subject, setSubject] = useState<string>(letterSubject ?? "");
  const [body, setBody]       = useState<string>(letterBody ?? "");
  const [bodyLoaded, setBodyLoaded]   = useState<boolean>(!!letterBody?.trim());
  const [draftError, setDraftError]   = useState<string | null>(null);

  const [busy, setBusy]     = useState<null | "email" | "source">(null);
  const [error, setError]   = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Set once the job is applied — the right column flips to the success view. */
  const [done, setDone] = useState<
    null | { via: "email"; to: string } | { via: "source"; opened: boolean }
  >(null);
  /** True once the listing has been handed off, so the confirm row can say so
   *  without taking the message off screen. */
  const [openedListing, setOpenedListing] = useState<null | { opened: boolean }>(null);

  // Set once this modal generates a letter itself. `letterId` (the prop) won't
  // catch up until the pane refetches its board-detail payload — this is what
  // lets the send/copy flow activate the instant writing finishes, without
  // waiting on that round trip.
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

  // `onChanged` is called from inside the fetch below but must not be a dep —
  // it is a fresh closure every render, and depending on it would re-run the
  // request on every keystroke in the message box.
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  // Only ever runs when the payload had no stored body — the first time this
  // job's message is needed. Everything after that is served from state.
  // `fetchEmailDraft` de-dupes against the Cover letter tab's identical
  // effect (frontend/web/src/lib/email/emailDraft.ts) — without it, opening
  // a job and clicking Apply before that tab's own draft landed fired the
  // AI voice-rewrite call twice for the same letter.
  useEffect(() => {
    if (!effectiveLetterId || bodyLoaded) return;
    let active = true;
    (async () => {
      try {
        const json = await fetchEmailDraft(effectiveLetterId);
        if (!active) return;
        setSubject((s) => s || (json.subject ?? ""));
        setBody(json.body ?? "");
        setBodyLoaded(true);
        // That route caches what it just composed onto the letter row, but the
        // pane is still holding the payload it fetched before there was one.
        // Refreshing it now means closing and reopening this popup reads the
        // stored body and skips the AI call entirely.
        onChangedRef.current?.();
      } catch (e) {
        if (active) setDraftError(e instanceof Error ? e.message : "Could not load the drafted message");
      }
    })();
    return () => { active = false; };
  }, [effectiveLetterId, bodyLoaded]);

  /** Persist the message so the Applied record shows what the user actually
   *  used, and so `/email-draft` stops re-rewriting it (POST /review sets
   *  `reviewed_at`, which is that route's "the user approved this" signal).
   *  Best-effort: a failure here must not block applying.
   *
   *  C67: the "nothing is lost either way" claim below only holds for
   *  sendEmail()'s caller — that path passes subject/body as an EXPLICIT
   *  override to /send-email, so even a failed persist here doesn't affect
   *  what actually gets sent. copyMessage() and openListing() have no such
   *  compensating step: this fetch is the ONLY place the user's edited
   *  wording is saved for those two flows. A silent failure there loses
   *  the edit for good — the Applications history and a later re-open of
   *  this modal would show the stale default text, not what was actually
   *  copied/opened. Still deliberately non-blocking (must not stop the
   *  user from applying), but now at least logged instead of invisible. */
  async function persistMessage(): Promise<void> {
    if (!effectiveLetterId || !body.trim()) return;
    try {
      const res = await fetch(`/api/applications/${effectiveLetterId}/review`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject: subject.trim() || defaultSubject, body }),
      });
      if (!res.ok) console.error(`[ApplyModal] failed to persist the edited message: HTTP ${res.status}`);
    } catch (e) {
      console.error("[ApplyModal] failed to persist the edited message:", e);
    }
  }

  /** Starts generation, auto-researching the company once if that's the only
   *  thing blocking it. A below-gate job here is often also a job whose company
   *  has never been researched (research is normally triggered as part of
   *  generating a letter — which below-gate jobs skip), so hitting this gate on
   *  the very first "Apply anyway" is the expected case, not a fluke.
   *  `didAutoResearch` stops it retrying more than once. */
  async function startGeneration(didAutoResearch: boolean): Promise<string> {
    const startRes = await fetch(`/api/jobs/${job.id}/cover-letter?override=final_gate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const startJson = await startRes.json().catch(() => ({}));

    if (!startRes.ok) {
      if (startRes.status === 422 && startJson.action === "research_company") {
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

    if (typeof startJson.letter_id !== "string") throw new Error("No letter_id came back — try again.");
    const newLetterId = startJson.letter_id;
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
    return newLetterId;
  }

  /** One click runs generate (auto-researching the company first if needed)
   *  → auto-pick the first opener → poll to completion. `override=final_gate`
   *  because this only ever fires for a below-gate job — the pipeline's own
   *  reason for skipping the letter, and exactly what "anyway" means. */
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

  async function copyMessage() {
    if (!body.trim()) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      // Copying almost always means it's about to be pasted into someone
      // else's form, so treat it as the user committing to this wording.
      void persistMessage();
    } catch {
      // Clipboard can be unavailable (permissions, insecure origin) — the
      // message is on screen to select by hand either way.
    }
  }

  async function sendEmail() {
    if (busy || !effectiveLetterId || !contactEmail) return;
    setBusy("email"); setError(null);
    try {
      // Render the CV here rather than letting the server fall back to the
      // stored ReportLab PDF. That fallback is a different renderer from the
      // one the Tailored CV tab and Download use, so the employer received a
      // document the user had never seen. This is the same client render the
      // Applications screen has always used — html2canvas + jsPDF over the
      // tailored markdown — so the attachment is the previewed bytes.
      const form = new FormData();
      form.set("subject", subject.trim() || defaultSubject);
      form.set("body", body);

      if (cvStoragePath) {
        try {
          // persistMessage and loadCvInputs are both independent network
          // round trips — running them in parallel rather than one after the
          // other was pure added latency on the slowest step of this flow.
          const [, { markdown, contactDetails }] = await Promise.all([
            persistMessage(),
            loadCvInputs(cvStoragePath),
          ]);
          const pdfBlob = await renderTailoredCvBlob({ markdown, contactDetails });
          const slug = (job.company || "company").replace(/[^a-zA-Z0-9]/g, "_");
          form.set("cv_pdf", pdfBlob, `TailoredCV_${slug}.pdf`);
        } catch (e) {
          // Stop here rather than posting without it. The server would then
          // reach for the legacy PDF or refuse, and neither outcome is worth
          // spending this letter's single send on.
          throw new Error(
            `Couldn't prepare your tailored CV, so nothing was sent: ${
              e instanceof Error ? e.message : "render failed"
            }. Try again.`,
          );
        }
      } else {
        await persistMessage();
      }

      const res = await fetch(`/api/applications/${effectiveLetterId}/send-email`, {
        method: "POST",
        // Multipart, not JSON — subject/body still ride along as explicit
        // overrides so what goes out is exactly the text on screen.
        body:   form,
      });
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
   *  applied. We have no way to know the user completed the employer's form:
   *  they may hit a login wall, find the ad expired, or change their mind.
   *  The confirm row below is always visible, so this only has to record that
   *  the tab was opened. */
  function openListing() {
    if (busy) return;
    setError(null);
    // Opened synchronously so it still counts as part of the click gesture —
    // popup blockers reject a window.open issued after an await. `win` comes
    // back null when the blocker actually intervenes.
    const win = window.open(job.url, "_blank", "noopener,noreferrer");
    setOpenedListing({ opened: !!win });
    void persistMessage();
  }

  async function confirmApplied() {
    if (busy) return;
    setBusy("source"); setError(null);
    try {
      await persistMessage();
      const res = await fetch(`/api/jobs/${job.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ applied_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Failed (${res.status})`);
      }
      setDone({ via: "source", opened: openedListing?.opened ?? false });
      onApplied();
    } catch {
      setError("Couldn't mark this job as applied — try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!mounted) return null;

  const hasMessage = bodyLoaded && !!body.trim();
  const canSend    = !!effectiveLetterId && !!contactEmail && hasMessage;
  // Nothing has been written for this job yet and nothing is on its way — the
  // only state where the generate button is the right thing to show.
  const needsGeneration = !effectiveLetterId && !awaitingLetter && !generating;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Apply for this job"
        className="relative w-full max-w-3xl rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl max-h-[88vh] overflow-y-auto"
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

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">

          {/* ── left: the message, in every state ─────────────────────── */}
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-caption uppercase tracking-wide font-bold text-text">
                Message to employer
              </span>
              {hasMessage && (
                <Button
                  size="xs"
                  className="ml-auto"
                  onClick={copyMessage}
                  icon={copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </div>

            {/* Two different waits, and they deserve different words. Either the
                pane's payload hasn't arrived yet (fast), or this letter has
                never had a message written for it and the server is composing
                one in the user's voice (slow — an AI call). Saying "loading"
                for the second one is what made it look hung. */}
            {(awaitingLetter || (!!effectiveLetterId && !bodyLoaded)) && !draftError && (
              <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3">
                <p className="flex items-center gap-2 text-label font-medium text-text">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  {awaitingLetter ? "Loading your message…" : "Writing your message…"}
                </p>
                {!awaitingLetter && (
                  <p className="mt-1.5 text-caption text-text-3">
                    First time for this job — we&apos;re drafting the note in your writing voice.
                    It&apos;s saved afterwards, so opening this again is instant.
                  </p>
                )}
              </div>
            )}
            {draftError && <p className="text-label text-danger">{draftError}</p>}

            {hasMessage && (
              <>
                <textarea
                  aria-label="Message to employer"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={12}
                  maxLength={MAX_APPLICATION_BODY_LEN}
                  spellCheck
                  className="w-full rounded-[10px] border border-border bg-surface text-text px-3.5 py-3 text-[13.5px] leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                />
                <p className="mt-1.5 text-caption text-text-3">
                  {contactEmail
                    ? "Edit it freely — this is the email body, and your tailored CV and cover letter go with it as attachments."
                    : "Edit it freely, then Copy — you'll paste this into the employer's form. Your tailored CV and cover letter are under Download in the panel header."}
                </p>
              </>
            )}

            {/* No letter, nothing in flight: offer to write one. This is only
                reachable below the final ATS gate, where the pipeline skips
                letter generation on purpose. */}
            {needsGeneration && (
              <div className="rounded-[10px] border border-dashed border-[var(--border)] px-3.5 py-3">
                <p className="text-label text-text-2">
                  Nothing has been written for this job yet — its ATS score didn&apos;t clear the
                  bar for us to do it automatically.
                </p>
                <button
                  type="button"
                  onClick={generateCoverLetter}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-3.5 py-1.5 text-label font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90"
                >
                  <PenLine className="w-3.5 h-3.5" /> Write my cover letter and message
                </button>
              </div>
            )}

            {/* Naming both artifacts matters: the panel above says "Message to
                employer", so a bare "writing your cover letter" reads as though
                the wrong thing is being produced. */}
            {generating && (
              <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3">
                <p className="flex items-center gap-2 text-label font-medium text-text">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  {researching
                    ? `Researching ${researching}…`
                    : "Writing your cover letter and this message…"}
                </p>
                <p className="mt-1.5 text-caption text-text-3">
                  {researching
                    ? "Paragraph 2 of the letter needs a real fact about them to anchor on. 15-45 seconds."
                    : "Two things are being produced: the cover letter that gets attached as a PDF, and the short message shown here. This usually takes a minute or two."}
                </p>
              </div>
            )}
            {generateError && (
              <div className="rounded-[10px] border border-danger-border bg-danger-subtle px-3.5 py-2.5">
                <p className="text-label text-danger">{generateError}</p>
                <button
                  type="button"
                  onClick={generateCoverLetter}
                  className="mt-1.5 text-label font-medium text-[var(--brand)] hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
          </div>

          {/* ── right: both ways to apply, always both on screen ──────── */}
          <div className="min-w-0 md:border-l md:border-[var(--border)] md:pl-5">
            {done ? (
              <SuccessCard job={job} done={done} onClose={onClose} />
            ) : (
              <>
                <p className="text-caption uppercase tracking-wide font-bold text-text-3 mb-2.5">
                  How would you like to apply?
                </p>

                {/* ── option 1: send it from here ── */}
                <div className="rounded-[10px] border border-[var(--border)] px-3.5 py-3">
                  <p className="flex items-center gap-1.5 text-body font-semibold text-text">
                    <Mail className="w-4 h-4 text-[var(--brand)]" /> Send via email
                  </p>
                  <p className="mt-0.5 text-caption text-text-3">
                    We&apos;ll attach your tailored CV and cover letter, and send the message on the left.
                  </p>

                  {contactEmail && !showAddEmail ? (
                    <div className="mt-2.5 flex items-center gap-2 text-label flex-wrap">
                      <span className="text-text-3">To:</span>
                      <span className="font-semibold text-text break-all">{contactEmail}</span>
                      <button
                        type="button"
                        onClick={() => { setShowAddEmail(true); setEmailError(null); }}
                        className="text-[var(--brand)] hover:underline font-medium"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2.5 flex items-center gap-2">
                      <input
                        type="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="recruiter@company.com"
                        className="field text-label py-1.5 flex-1 min-w-0"
                      />
                      <Button
                        variant="brand" size="sm"
                        onClick={saveEmail}
                        disabled={savingEmail || !emailInput.trim()}
                      >
                        {savingEmail ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                  )}
                  {emailError && <p className="mt-1.5 text-label text-danger">{emailError}</p>}

                  <button
                    type="button"
                    onClick={sendEmail}
                    disabled={!canSend || !!busy}
                    title={
                      !contactEmail   ? "Add the employer's email address first"
                      : !hasMessage   ? "There's no message to send yet"
                      : "Sends the message with your CV and cover letter attached"
                    }
                    className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--brand)] py-2 text-body font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy === "email"
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Mail className="h-4 w-4" />}
                    {busy === "email" ? "Sending…" : "Send with CV & cover letter"}
                  </button>
                </div>

                <div className="my-3 flex items-center gap-2">
                  <span className="h-px flex-1 bg-[var(--border)]" />
                  <span className="text-caption uppercase tracking-wide font-bold text-text-3">or</span>
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>

                {/* ── option 2: apply on the listing, confirm afterwards ──
                    The confirm row is visible from the start rather than
                    appearing only after the hand-off. Someone who applied on
                    the listing in another session comes back to this popup
                    wanting exactly this button, and hiding it behind "open the
                    tab again" made them re-open a form they'd already sent. */}
                <div className="rounded-[10px] border border-[var(--border)] overflow-hidden">
                  <div className="px-3.5 py-3">
                    <p className="flex items-center gap-1.5 text-body font-semibold text-text">
                      <Link2 className="w-4 h-4 text-[var(--brand)]" /> Apply on {job.source}
                    </p>
                    <p className="mt-0.5 text-caption text-text-3">
                      Copy the message first — you&apos;ll need it on their form.
                    </p>
                    <button
                      type="button"
                      onClick={openListing}
                      disabled={!!busy}
                      className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-[var(--border)] py-2 text-body font-medium text-text transition-colors hover:bg-[var(--bg)] disabled:opacity-50"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open {job.source} ↗
                    </button>
                    {openedListing && (
                      <p className="mt-2 text-caption text-text-3">
                        {openedListing.opened ? (
                          <>Opened in a new tab — finish there, then confirm below.</>
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
                            .
                          </>
                        )}
                      </p>
                    )}
                  </div>

                  {/* The confirm step only appears once the listing has been
                      handed off — asking "did you apply?" before the user has
                      been anywhere is premature, and it made the panel look
                      like it was pushing them to claim an application.
                      It appears in place, underneath, rather than replacing
                      the body: the message on the left has to stay on screen
                      for the form they now have open. */}
                  {openedListing ? (
                    <div className="border-t border-[var(--border)] bg-warning-subtle px-3.5 py-3">
                      <p className="text-caption text-text-2">
                        Finished on {job.source}? We&apos;ll move this job to Applied — we never
                        mark it for you.
                      </p>
                      <div className="mt-2.5 flex gap-2">
                        <button
                          type="button"
                          onClick={confirmApplied}
                          disabled={!!busy}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-success py-2 text-body font-medium text-success-fg transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {busy === "source"
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <CheckCircle2 className="h-4 w-4" />}
                          {busy === "source" ? "Saving…" : "Yes, I applied"}
                        </button>
                        <Button
                          variant="default"
                          size="sm"
                          type="button"
                          onClick={onClose}
                          disabled={!!busy}
                          className="flex-1 rounded-full py-2 text-body font-medium"
                        >
                          Not yet
                        </Button>
                      </div>
                    </div>
                  ) : (
                    /* Someone who applied in an earlier session still needs a
                       way in, but it stays a quiet text link rather than a
                       button competing with the two real actions above. */
                    <div className="border-t border-[var(--border)] px-3.5 py-2.5">
                      <button
                        type="button"
                        onClick={confirmApplied}
                        disabled={!!busy}
                        className="text-caption text-text-3 hover:text-[var(--brand)] hover:underline disabled:opacity-50"
                      >
                        {busy === "source" ? "Saving…" : "Already applied to this job? Mark it as applied"}
                      </button>
                    </div>
                  )}
                </div>

                {error && <p className="mt-3 text-label text-danger">{error}</p>}
              </>
            )}
          </div>
        </div>

        <p className="mt-5 border-t border-[var(--border)] pt-3 text-caption text-text-3">
          Once this job is applied, the message you used stays on its{" "}
          <b className="font-semibold text-text-2">Cover letter</b> tab — copy it from there any time.
        </p>
      </div>
    </div>,
    document.body,
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
      <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
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
            We&apos;ve moved this job to your Applied pile so you can track it. The message you
            used is kept on its Cover letter tab.
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
