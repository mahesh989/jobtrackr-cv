"use client";

/**
 * Cover letter tab — the editing home for BOTH artifacts a job carries:
 *
 *   • Cover letter      — the PDF that gets attached
 *   • Message to employer — the email body, or the text pasted into a listing's
 *                           "message to the hiring manager" box
 *
 * They are separate things and users don't hold that distinction on their own,
 * so both are labelled explicitly.
 *
 * This replaces the old read-only preview plus the More tab's email section,
 * which let you type into a textarea and then silently threw the edit away
 * (it copied and sent `draft.body`, never the edited value).
 *
 * Once the application email has gone out the letter is frozen: PATCH the
 * letter, POST /review and GET /email-draft all 409 from that point. Rather
 * than mount editors that can only fail, the sent case renders the stored
 * copy straight off the board payload — which is also how someone who applied
 * on a job board and forgot to copy their message gets it back.
 */

import { useState } from "react";
import { Copy, Check, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui";
import { useCoverLetter } from "@/features/applications/hooks/useCoverLetter";
import { useEmailDraft } from "@/features/applications/hooks/useEmailDraft";
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
  jobId, letter, onChanged,
}: {
  jobId:      string;
  letter:     BoardDetailCoverLetter;
  onChanged?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const sent = !!letter.email_sent_at;

  // Passing null/false rather than branching the call — hooks stay unconditional
  // and neither one fires a request that the send lock would 409.
  const cover = useCoverLetter(sent ? null : letter.id, setError, !sent, onChanged);
  const email = useEmailDraft(sent ? null : letter.id, setError, !sent);

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

      {/* ── Message to employer ──────────────────────────────────── */}
      {sent ? (
        <SectionShell
          title="Message to employer"
          meta={<span className="text-[12px] text-text-3">What was sent</span>}
          footer={<CopyButton text={letter.email_body ?? ""} />}
        >
          {letter.email_subject && (
            <p className="text-[13px] text-text mb-2">
              <span className="text-text-3">Subject: </span>
              <b className="font-semibold">{letter.email_subject}</b>
            </p>
          )}
          {letter.email_body?.trim() ? (
            <p className="text-[14px] text-text whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto">
              {letter.email_body}
            </p>
          ) : (
            <p className="text-[13px] text-text-3 italic">No message was stored for this application.</p>
          )}
        </SectionShell>
      ) : (
        <SectionShell
          title="Message to employer"
          meta={
            <>
              {email.dirty && <DirtyDot />}
              <span className="text-[12px] text-text-3">Email body, or paste it into the listing&apos;s message box</span>
            </>
          }
          footer={
            <>
              <CopyButton text={email.body} />
              <span className="text-[12px] text-text-3">
                {email.dirty ? "Unsaved changes" : "Saved"}
              </span>
              {email.dirty && (
                <Button
                  variant="brand" size="xs" className="ml-auto"
                  onClick={email.save} disabled={email.saving} isLoading={email.saving}
                  icon={<Save className="w-3 h-3" />}
                >
                  {email.saving ? "Saving…" : "Save changes"}
                </Button>
              )}
            </>
          }
        >
          {email.loading ? (
            <div className="py-8 flex items-center justify-center text-text-3 text-[13px]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading your drafted message…
            </div>
          ) : (
            <div className="space-y-2.5">
              <label className="block">
                <span className="block text-[11px] font-semibold text-text-3 mb-1">Subject</span>
                <input
                  type="text"
                  value={email.subject}
                  onChange={(e) => email.setSubject(e.target.value)}
                  disabled={email.saving}
                  maxLength={300}
                  className="w-full rounded-[8px] border border-border bg-surface text-text px-3 py-2 text-[14px] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-text-3 mb-1">Message</span>
                <textarea
                  value={email.body}
                  onChange={(e) => email.setBody(e.target.value)}
                  disabled={email.saving}
                  rows={8}
                  maxLength={20_000}
                  spellCheck
                  className={TEXTAREA_CLS}
                />
              </label>
              <p className="text-[11.5px] text-text-3">
                Save your edits before sending — the tailored CV and cover letter go as PDF attachments, so keep this short.
              </p>
            </div>
          )}
        </SectionShell>
      )}
    </div>
  );
}
