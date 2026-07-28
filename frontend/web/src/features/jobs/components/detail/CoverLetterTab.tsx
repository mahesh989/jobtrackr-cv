"use client";

/**
 * Cover letter tab — edits the letter itself, and nothing else.
 *
 * The short message to the employer (email body / the text you paste into a
 * listing's "message to the hiring manager" box) deliberately does NOT live
 * here. It is only ever used at the moment of applying, so it is edited in the
 * Apply popup, next to the Send button that consumes it. Editing it in two
 * places meant two save buttons for one piece of text.
 *
 * Once the application email has gone out the letter is frozen: PATCH the
 * letter, POST /review and GET /email-draft all 409 from that point. Rather
 * than mount an editor that can only fail, the sent case renders the stored
 * copy straight off the board payload — including the message that was sent,
 * which is otherwise unreachable once the Apply popup stops offering it.
 */

import { useState } from "react";
import { Copy, Check, Loader2, Save } from "lucide-react";
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
  title, meta, children, footer,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="rounded-[10px] border border-border overflow-hidden bg-surface">
      <header className="flex items-center gap-2 flex-wrap px-[14px] py-[9px] border-b border-[var(--border-muted)] bg-[#fafbfc]">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.05em] text-text-3">{title}</h4>
        {meta}
      </header>
      <div className="px-[14px] py-3">{children}</div>
      {footer && (
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
  const showSentMessage = (sent || applied) && !!letter.email_body?.trim();

  // Passing null/false rather than branching the call — the hook stays
  // unconditional and never fires a request that the send lock would 409.
  const cover = useCoverLetter(sent ? null : letter.id, setError, !sent, onChanged);

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

      {/* ── Message to employer — sent applications only ─────────────
          The editable copy lives in the Apply popup, which is where the
          message is actually used and the only place it can be sent from.
          Keeping a second editor here meant the same text in two places with
          two save buttons. What stays is the read-only record of what went
          out: once an application is sent that message is unreachable
          anywhere else, and "what did I actually say to them?" is a question
          that gets asked weeks later, before an interview. */}
      {showSentMessage && (
        <SectionShell
          title="Message to employer"
          meta={
            <span className="text-[12px] text-text-3">
              {sent ? "What was sent" : "What you used to apply"}
            </span>
          }
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
      )}
    </div>
  );
}
