"use client";

/**
 * SentEmailModal — read-only popup that surfaces the email subject + body that
 * was sent (or prepared to be sent) for an already-applied job. Lives behind a
 * single "Email message" button on the Sent / Applied card so the user can
 * always come back later and copy what they sent.
 *
 * Loads /api/applications/[letterId]/email-draft (which returns the most
 * recent subject + body saved on the cover_letters row) and renders it in a
 * read-only modal with a Copy button.
 */

import { useEffect, useState } from "react";
import { Loader2, Copy, Check, Mail } from "lucide-react";
import { Modal, Button } from "@/components/ui";

interface Props {
  letterId: string;
  jobLabel: string;
  onClose:  () => void;
}

interface Draft {
  to:        string | null;
  to_email:  string | null;
  subject:   string;
  body:      string;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function SentEmailModal({ letterId, jobLabel, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [draft,   setDraft]   = useState<Draft | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [copied,  setCopied]  = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res  = await fetch(`/api/applications/${letterId}/email-draft`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error ?? `Load failed (${res.status})`); return; }
        setDraft({
          to:       json.to       ?? null,
          to_email: json.to_email ?? null,
          subject:  json.subject  ?? "",
          body:     json.body     ?? "",
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [letterId]);

  async function handleCopy() {
    if (!draft) return;
    const payload = `Subject: ${draft.subject}\n\n${draft.body}`;
    const ok = await copyToClipboard(payload);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setError("Clipboard blocked — select the message text and copy manually.");
    }
  }

  return (
    <Modal open onClose={onClose} size="lg">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-semibold text-[var(--text)] flex items-center gap-1.5">
            <Mail className="w-4 h-4 text-[var(--brand)]" /> Email message
          </h2>
          <p className="text-caption text-[var(--text-3)] mt-0.5 truncate">{jobLabel}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={handleCopy}
            disabled={loading || !draft}
            variant="primary"
            className="inline-flex items-center gap-1 text-label px-3 py-1.5 disabled:opacity-40"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy email"}
          </Button>
        </div>
      </div>

      <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
        {loading ? (
          <div className="py-10 flex items-center justify-center text-[var(--text-3)] text-label">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : draft ? (
          <>
            {draft.to_email && (
              <div>
                <label className="block text-micro font-semibold uppercase tracking-wider text-[var(--text-3)] mb-1">To</label>
                <div className="text-label font-mono px-3 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]">
                  {draft.to ?? draft.to_email}
                </div>
              </div>
            )}
            <div>
              <label className="block text-micro font-semibold uppercase tracking-wider text-[var(--text-3)] mb-1">Subject</label>
              <div className="text-body px-3 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]">
                {draft.subject || <span className="italic text-[var(--text-3)]">(no subject)</span>}
              </div>
            </div>
            <div>
              <label className="block text-micro font-semibold uppercase tracking-wider text-[var(--text-3)] mb-1">Message</label>
              <pre className="text-body leading-relaxed px-3 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] whitespace-pre-wrap font-sans select-text">
                {draft.body || <span className="italic text-[var(--text-3)]">(no body)</span>}
              </pre>
            </div>
            {!draft.to_email && (
              <p className="text-caption text-[var(--text-3)]">
                No contact email was on file — this is the message you copied + sent manually.
              </p>
            )}
          </>
        ) : null}

        {error && (
          <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2">
            <p className="text-label text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
