"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, X, Send, Paperclip, RotateCcw } from "lucide-react";
import { renderTailoredCvBlob } from "@/lib/cvPdfRender";
import type { ContactDetails } from "@/lib/cvMarkdownHelpers";

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
  cv_markdown:     string | null;
  contact_details: ContactDetails | null;
}

type CvRenderState =
  | { state: "idle" }
  | { state: "rendering" }
  | { state: "ready"; blob: Blob }
  | { state: "failed"; error: string }
  | { state: "skipped" };  // no CV markdown available

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
  const [cvRender, setCvRender] = useState<CvRenderState>({ state: "idle" });

  // Once a CV render finishes we keep the blob around so re-clicking Send
  // doesn't trigger a second 1-2s html2canvas pass.
  const cvBlobRef = useRef<Blob | null>(null);

  // Initial load — fetch the draft, then kick off the CV render in background
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
        const d = json as Draft;
        setDraft(d);
        setSubject(d.subject ?? "");
        setBody(d.body ?? "");

        // Render the CV PDF in the background so it's ready by the time the
        // user clicks Send. Same pipeline as TailoredCvCard so the attached
        // PDF matches what they'd see on the analysis page.
        if (d.cv_markdown) {
          setCvRender({ state: "rendering" });
          try {
            const blob = await renderTailoredCvBlob({
              markdown:       d.cv_markdown,
              contactDetails: d.contact_details,
            });
            if (cancelled) return;
            cvBlobRef.current = blob;
            setCvRender({ state: "ready", blob });
          } catch (renderErr) {
            if (cancelled) return;
            console.warn("[ComposeEmailModal] CV render failed:", renderErr);
            setCvRender({
              state: "failed",
              error: renderErr instanceof Error ? renderErr.message : "CV render failed",
            });
          }
        } else {
          setCvRender({ state: "skipped" });
        }
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

    // If the CV render is still in flight, wait for it before posting.
    // Otherwise the server falls back to the legacy PDF which doesn't match
    // what the user previewed on the analysis page.
    if (draft.cv_markdown && cvRender.state === "rendering") {
      setError("CV is still rendering — give it a moment and try again.");
      return;
    }

    setError(null);
    setSending(true);
    try {
      const form = new FormData();
      form.set("subject", subject.trim());
      form.set("body",    body);

      const blob = cvBlobRef.current
        ?? (cvRender.state === "ready" ? cvRender.blob : null);
      if (blob) {
        const slug = (draft.job_company ?? "company").replace(/[^a-zA-Z0-9]/g, "_");
        form.set("cv_pdf", blob, `TailoredCV_${slug}.pdf`);
      }

      const res = await fetch(`/api/applications/${letterId}/send-email`, {
        method: "POST",
        body:   form,
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
                  {draft.attachments.map((name) => {
                    const isCv = name.startsWith("TailoredCV_");
                    return (
                      <li key={name} className="flex items-center gap-1.5 text-[12px] text-text-2">
                        <Paperclip className="w-3 h-3 text-text-3 shrink-0" />
                        <span className="font-mono">{name}</span>
                        {isCv && cvRender.state === "rendering" && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-text-3 ml-1">
                            <Loader2 className="w-3 h-3 animate-spin" /> rendering…
                          </span>
                        )}
                        {isCv && cvRender.state === "ready" && (
                          <span className="text-[10px] text-emerald-600 ml-1">ready</span>
                        )}
                        {isCv && cvRender.state === "failed" && (
                          <span className="text-[10px] text-amber-700 ml-1">render failed — server fallback</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {!draft.has_tailored_cv && (
                  <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1">
                    No tailored CV markdown found for this job — only the cover letter will be attached.
                  </p>
                )}
                {cvRender.state === "ready" && (
                  <p className="text-[10px] text-text-3 mt-1">
                    Tailored CV rendered fresh from your current contact details — matches the analysis-page download.
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
            disabled={
              sending || loading || !draft || !subject.trim() || !body.trim()
              || cvRender.state === "rendering"
            }
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5 disabled:opacity-40"
            title={cvRender.state === "rendering" ? "Waiting for the CV PDF to finish rendering" : undefined}
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {cvRender.state === "rendering" ? "Rendering CV…" : "Send now"}
          </button>
        </div>
      </div>
    </div>
  );
}
