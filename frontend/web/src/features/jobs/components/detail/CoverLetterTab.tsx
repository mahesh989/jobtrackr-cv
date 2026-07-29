"use client";

/**
 * Cover letter tab — edits the letter, and (once there's a drafted message to
 * edit) the message to employer alongside it.
 *
 * Once the application email has gone out the letter AND the message are both
 * frozen: PATCH the letter, POST /review and GET /email-draft all 409 from
 * that point (`cover_letters.email_sent_at` is the gate the backend checks).
 * Rather than mount editors that can only fail, the sent case renders the
 * stored copy straight off the board payload — including the message that was
 * sent, which is otherwise unreachable once the Apply popup stops offering it.
 *
 * Before that point — including the "applied on the listing, nothing emailed"
 * case, which sets `applied_at` but never `email_sent_at` — the same POST
 * /review the Apply popup itself uses is still open, so the message is edited
 * and saved right here instead of only being reachable from that one-shot popup.
 */

import { useState } from "react";
import { Copy, Check, Loader2, Save, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui";
import { useCoverLetter } from "@/features/applications/hooks/useCoverLetter";
import type { BoardDetailCoverLetter } from "../../lib/boardDetailTypes";

const TEXTAREA_CLS =
  "w-full rounded-[8px] border border-border bg-surface text-text px-3.5 py-3 " +
  "text-[14px] leading-relaxed resize-y focus:outline-none focus:ring-1 " +
  "focus:ring-[var(--brand)] disabled:opacity-60";

function wordsIn(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Shared copy-to-clipboard button with the "Copied ✓" flash. */
function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      disabled={!text.trim()}
      icon={copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          },
          () => {},
        );
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function SectionShell({
  title, meta, children, footer, collapsible = false, defaultOpen = true,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Starts folded and toggles open on header click — used for the
   *  "Message to employer" record, which is a look-up-later reference rather
   *  than the reason someone opens this tab, and reads better as a fold-out
   *  than always-on screen space above the letter. */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  return (
    <section className="rounded-[10px] border border-border overflow-hidden bg-surface">
      <header
        className={`flex items-center gap-2 flex-wrap px-[14px] py-[9px] bg-[#fafbfc] ${open ? "border-b border-[var(--border-muted)]" : ""} ${collapsible ? "cursor-pointer select-none" : ""}`}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
      >
        {collapsible && (
          <ChevronRight className={`w-3.5 h-3.5 text-text-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        )}
        <h4 className="text-[11px] font-bold uppercase tracking-[0.05em] text-text-3">{title}</h4>
        {meta}
      </header>
      {open && <div className="px-[14px] py-3">{children}</div>}
      {open && footer && (
        <footer className="flex items-center gap-2 flex-wrap px-[14px] py-[9px] border-t border-[var(--border-muted)] bg-[#fafbfc]">
          {footer}
        </footer>
      )}
    </section>
  );
}

function DirtyDot() {
  return <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Unsaved changes" />;
}

export function CoverLetterTab({
  jobId, letter, applied = false, onChanged,
}: {
  jobId:      string;
  letter:     BoardDetailCoverLetter;
  /** The job is marked applied. Applying on a listing persists the message but
   *  never sets `email_sent_at` (nothing was emailed), so without this the one
   *  case the message most needs recovering in — "I applied on Seek, what did I
   *  paste into their form?" — would show no message at all. */
  applied?:   boolean;
  onChanged?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const sent = !!letter.email_sent_at;
  const showMessage = (sent || applied) && !!letter.email_body?.trim();

  // Passing null/false rather than branching the call — the hook stays
  // unconditional and never fires a request that the send lock would 409.
  const cover = useCoverLetter(sent ? null : letter.id, setError, !sent, onChanged);

  // Message-to-employer edit state. Local rather than a fetch-backed hook like
  // `cover` — the subject/body are already on the board payload, no round trip
  // needed to start editing. `POST /review` is the same endpoint the Apply
  // popup's own Approve button uses, and it stays open right up until
  // `email_sent_at` is set, so this is not a second implementation of saving,
  // just a second place to reach the one that already exists.
  const [subject, setSubject] = useState(letter.email_subject ?? "");
  const [body, setBody] = useState(letter.email_body ?? "");
  const [savedSubject, setSavedSubject] = useState(letter.email_subject ?? "");
  const [savedBody, setSavedBody] = useState(letter.email_body ?? "");
  const [messageSaving, setMessageSaving] = useState(false);
  const messageDirty = subject !== savedSubject || body !== savedBody;

  async function saveMessage() {
    if (messageSaving) return;
    setMessageSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${letter.id}/review`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject, body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Save failed (${res.status})`);
      setSavedSubject(subject);
      setSavedBody(body);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save message");
    } finally {
      setMessageSaving(false);
    }
  }

  const pdfHref = `/api/jobs/${jobId}/cover-letter/${letter.id}/download?format=pdf`;

  const viewPdfLink = (
    <a
      href={pdfHref}
      target="_blank"
      rel="noopener noreferrer"
      className="ml-auto text-[12px] font-medium text-[var(--brand)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] rounded"
    >
      View PDF ↗
    </a>
  );

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-[8px] bg-red-light border border-red/20 px-3.5 py-2 text-[13px] text-red">{error}</p>
      )}

      {sent && (
        <p className="rounded-[8px] border border-border bg-[#fafbfc] px-3.5 py-2 text-[13px] text-text-2">
          This application was emailed on{" "}
          <b className="text-text font-semibold">
            {new Date(letter.email_sent_at as string).toLocaleDateString(undefined, {
              day: "numeric", month: "short", year: "numeric",
            })}
          </b>
          . It&apos;s kept here read-only — copy anything you need.
        </p>
      )}

      {/* ── Cover letter ─────────────────────────────────────────── */}
      {sent ? (
        <SectionShell
          title="Cover letter"
          meta={
            <>
              <span className="text-[12px] text-text-3">
                {wordsIn(letter.pass_3_final ?? "")} words
                {letter.tone_target ? ` · ${letter.tone_target} tone` : ""}
              </span>
              {viewPdfLink}
            </>
          }
          footer={<CopyButton text={letter.pass_3_final ?? ""} label="Copy letter" />}
        >
          {letter.pass_3_final?.trim() ? (
            <p className="text-[14px] text-text whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto">
              {letter.pass_3_final}
            </p>
          ) : (
            <p className="text-[13px] text-text-3 italic">No cover letter text.</p>
          )}
        </SectionShell>
      ) : (
        <SectionShell
          title="Cover letter"
          meta={
            <>
              {cover.dirty && <DirtyDot />}
              <span className="text-[12px] text-text-3">
                {wordsIn(cover.text)} words
                {letter.tone_target ? ` · ${letter.tone_target} tone` : ""}
              </span>
              {viewPdfLink}
            </>
          }
          footer={
            <>
              <span className="text-[12px] text-text-3">
                {cover.dirty ? "Unsaved changes" : "Saved — this is what the PDF and the email attachment use."}
              </span>
              {cover.dirty && (
                <Button
                  variant="brand" size="xs" className="ml-auto"
                  onClick={cover.save} disabled={cover.saving} isLoading={cover.saving}
                  icon={<Save className="w-3 h-3" />}
                >
                  {cover.saving ? "Saving…" : "Save changes"}
                </Button>
              )}
            </>
          }
        >
          {cover.loading ? (
            <div className="py-8 flex items-center justify-center text-text-3 text-[13px]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading cover letter…
            </div>
          ) : (
            <textarea
              aria-label="Cover letter"
              value={cover.text}
              onChange={(e) => cover.setText(e.target.value)}
              disabled={cover.saving}
              rows={16}
              spellCheck
              className={TEXTAREA_CLS}
            />
          )}
        </SectionShell>
      )}

      {/* ── Message to employer ──────────────────────────────────────
          Sent applications: a frozen, read-only record — once an email has
          gone out that message is unreachable anywhere else, and "what did I
          actually say to them?" is a question that gets asked weeks later,
          before an interview. Everything else (including "applied on the
          listing, nothing emailed"): editable and saveable right here via the
          same POST /review the Apply popup itself uses. */}
      {showMessage && (
        sent ? (
          <SectionShell
            title="Message to employer"
            collapsible
            defaultOpen={false}
            meta={<span className="text-[12px] text-text-3">What was sent</span>}
            footer={<CopyButton text={letter.email_body ?? ""} />}
          >
            {letter.email_subject && (
              <p className="text-[13px] text-text mb-2">
                <span className="text-text-3">Subject: </span>
                <b className="font-semibold">{letter.email_subject}</b>
              </p>
            )}
            <p className="text-[14px] text-text whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto">
              {letter.email_body}
            </p>
          </SectionShell>
        ) : (
          <SectionShell
            title="Message to employer"
            collapsible
            defaultOpen={false}
            meta={
              <>
                {messageDirty && <DirtyDot />}
                <span className="text-[12px] text-text-3">What you used to apply</span>
              </>
            }
            footer={
              <>
                <span className="text-[12px] text-text-3">
                  {messageDirty ? "Unsaved changes" : "Saved"}
                </span>
                {messageDirty && (
                  <Button
                    variant="brand" size="xs" className="ml-auto"
                    onClick={saveMessage} disabled={messageSaving} isLoading={messageSaving}
                    icon={<Save className="w-3 h-3" />}
                  >
                    {messageSaving ? "Saving…" : "Save changes"}
                  </Button>
                )}
                {!messageDirty && <CopyButton text={savedBody} />}
              </>
            }
          >
            <input
              aria-label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={messageSaving}
              placeholder="Subject"
              className="w-full rounded-[8px] border border-border bg-surface text-text px-3.5 py-2 text-[13px] mb-2 focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
            />
            <textarea
              aria-label="Message to employer"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={messageSaving}
              rows={8}
              spellCheck
              className={TEXTAREA_CLS}
            />
          </SectionShell>
        )
      )}
    </div>
  );
}
