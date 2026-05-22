"use client";

import { useState, useEffect } from "react";
import { Loader2, X, Send, Paperclip, RotateCcw } from "lucide-react";

interface Draft {
  to:              string;
  to_email:        string;
  hiring_manager:  string | null;
  job_title:       string | null;
  job_company:     string | null;
  user_name:       string | null;
  subject:         string;
  body:            string;
  attachments:     string[];
  has_tailored_cv: boolean;
}

interface Props {
  letterId:  string;
  jobLabel?: string;       // optional summary shown in header e.g. "Category Analyst @ Minor DKL"
  onClose:   () => void;
  onSent:    (toEmail: string) => void;
}

/**
 * Compose / review modal that opens between clicking Send and actually
 * dispatching the email. Lazy-loads the prefilled draft so the recipient,
 * subject, and body shown match exactly what /send-email would have used
 * without overrides. User can edit subject + body, then click Send to fire
 * the actual POST.
 *
 * On 409 (letter already sent) the modal surfaces the error inline; the
 * Send button stays disabled.
 */
export function ComposeEmailModal({ letterId, jobLabel, onClose, onSent }: Props) {
  const [loading, setLoading]   = useState(true);
  const [sending, setSending]   = useState(false);
  const [draft,   setDraft]     = useState<Draft | null>(null);
  const [subject, setSubject]   = useState("");
  const [body,    setBody]      = useState("");
  const [error,   setError]     = useState<string | null>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res  = await fetch(`/api/applications/${letterId}/email-draft`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `Load failed (${res.status})`);
          return;
        }
        setDraft(json as Draft);
        setSubject(json.subject ?? "");
        setBody(json.body ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [letterId]);

  // Escape closes (unless sending)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  function resetDefaults() {
    if (!draft) return;
    setSubject(draft.subject);
    setBody(draft.body);
  }

  async function handleSend() {
    if (sending || loading || !draft) return;
    if (!subject.trim()) { setError("Subject can't be empty"); return; }
    if (!body.trim())    { setError("Body can't be empty"); return; }
    setError(null);
    setSending(true);
    try {
      const res = await fetch(`/api/applications/${letterId}/send-email`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject: subject.trim(), body }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Send failed (${res.status})`);
        setSending(false);
        return;
      }
      onSent(json.to ?? draft.to_email);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSending(false);
    }
  }

  const dirty = draft != null
    && (subject !== draft.subject || body !== draft.body);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !sending && onClose()}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-text">Review email before sending</h2>
            <p className="text-[11px] text-text-3 mt-0.5 truncate">
              {jobLabel ?? "Nothing leaves your account until you click Send."}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={sending}
            className="text-text-3 hover:text-text disabled:opacity-40 shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-3">
          {loading ? (
            <div className="py-10 flex items-center justify-center text-text-3 text-[12px]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading draft…
            </div>
          ) : draft ? (
            <>
              {/* To (read-only) */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">
                  To
                </label>
                <div className="text-[12px] font-mono px-3 py-2 rounded border border-border bg-[var(--surface-2)] text-text">
                  {draft.to}
                </div>
              </div>

              {/* Subject (editable) */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">
                  Subject
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={sending}
                  maxLength={300}
                  className="w-full text-[13px] px-3 py-2 rounded border border-border bg-surface text-text focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                />
              </div>

              {/* Body (editable) */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">
                  Message
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={sending}
                  maxLength={20000}
                  rows={10}
                  className="w-full text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                  spellCheck
                />
                <p className="text-[10px] text-text-3 mt-1">
                  The cover letter PDF is attached separately — keep this body short.
                </p>
              </div>

              {/* Attachments */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">
                  Attachments ({draft.attachments.length})
                </label>
                <ul className="space-y-1">
                  {draft.attachments.map((name) => (
                    <li key={name} className="flex items-center gap-1.5 text-[12px] text-text-2">
                      <Paperclip className="w-3 h-3 text-text-3 shrink-0" />
                      <span className="font-mono">{name}</span>
                    </li>
                  ))}
                </ul>
                {!draft.has_tailored_cv && (
                  <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1">
                    No tailored CV PDF found for this job — only the cover letter will be attached.
                  </p>
                )}
              </div>
            </>
          ) : null}

          {error && (
            <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2">
              <p className="text-[12px] text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          {dirty && (
            <button
              onClick={resetDefaults}
              disabled={sending}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40 mr-auto"
              title="Restore the default subject + body"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to default
            </button>
          )}
          <button
            onClick={onClose}
            disabled={sending}
            className="text-[12px] text-text-2 hover:text-text px-3 py-1.5 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || loading || !draft || !subject.trim() || !body.trim()}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5 disabled:opacity-40"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send now
          </button>
        </div>
      </div>
    </div>
  );
}
