"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  jobId:              string;
  originalJd:         string;                    // jobs.description (raw scrape)
  initialManual:      string | null;             // jobs.manual_jd_text
  initialEmail:       string | null;             // jobs.contact_email
  initialHiringMgr:   string | null;             // jobs.hiring_manager
  onClose():          void;
  onSaved(patch: { manual_jd_text: string | null; contact_email: string | null; hiring_manager: string | null }): void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function JobEditModal({
  jobId, originalJd, initialManual, initialEmail, initialHiringMgr, onClose, onSaved,
}: Props) {
  // The textarea starts with whatever the user previously set, falling back
  // to the raw scraped description so they can edit-in-place.
  const [text, setText]       = useState<string>(initialManual ?? originalJd ?? "");
  const [email, setEmail]     = useState<string>(initialEmail ?? "");
  const [hiringMgr, setHiringMgr] = useState<string>(initialHiringMgr ?? "");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Track whether the field has been edited so we know how to interpret it.
  const wasOriginallyEdited = initialManual !== null && initialManual !== "";

  useEffect(() => {
    // Focus the textarea on open for keyboard-first UX.
    taRef.current?.focus();
  }, []);

  async function save() {
    setError(null);
    setBusy(true);

    const trimmedText  = text.trim();
    const trimmedEmail = email.trim();
    const trimmedHiringMgr = hiringMgr.trim();

    // Decide what manual_jd_text becomes:
    //   - identical to originalJd        → null (don't store a copy of the scrape)
    //   - empty                          → null
    //   - anything else                  → trimmedText
    const manualForApi =
      trimmedText === "" || trimmedText === (originalJd ?? "").trim()
        ? null
        : trimmedText;

    if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
      setError(`'${trimmedEmail}' is not a valid email address`);
      setBusy(false);
      return;
    }

    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          manual_jd_text: manualForApi,
          contact_email:  trimmedEmail === "" ? null : trimmedEmail,
          hiring_manager: trimmedHiringMgr === "" ? null : trimmedHiringMgr,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Failed (${res.status})`);
        setBusy(false);
        return;
      }
      onSaved({
        manual_jd_text: json.manual_jd_text ?? null,
        contact_email:  json.contact_email ?? null,
        hiring_manager: json.hiring_manager ?? null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  function resetToOriginal() {
    setText(originalJd ?? "");
  }

  const charCount = text.length;
  const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-text/40 backdrop-blur-sm"
        onClick={() => !busy && onClose()}
      />
      <div className="relative bg-white rounded-lg border border-[var(--border)] shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <h2 className="text-[15px] font-semibold text-text">Edit job inputs</h2>
          <p className="text-[12px] text-text-2 mt-0.5 leading-snug">
            Trim out the noise — company blurb, EEO statement, benefits — so the
            AI focuses on responsibilities and skills. The original scrape is
            preserved either way.
          </p>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-5 flex-1">
          {/* JD text */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label htmlFor="jd-edit" className="block text-[12px] font-medium text-text">
                Job description (what the AI will see)
              </label>
              <span className="text-[11px] text-text-2 tabular-nums">
                {charCount.toLocaleString()} chars · {wordCount.toLocaleString()} words
              </span>
            </div>
            <textarea
              id="jd-edit"
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={16}
              spellCheck={false}
              className="w-full bg-white border border-[var(--border)] rounded-md px-3 py-2 text-[12px] text-text leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 resize-y"
            />
            <div className="flex items-center gap-3 mt-1.5">
              <button
                type="button"
                onClick={resetToOriginal}
                disabled={busy}
                className="text-[11px] text-[var(--brand)] hover:underline"
                title="Replace the editor contents with the original scraped description"
              >
                Reset to original scrape
              </button>
              {wasOriginallyEdited && (
                <span className="text-[11px] text-[#9A6700] bg-[#FFF8C5] border border-[#D4A72C]/40 px-1.5 py-0.5 rounded">
                  Edited JD active
                </span>
              )}
            </div>
          </div>

          {/* Email */}
          <div>
            <label htmlFor="job-email" className="block text-[12px] font-medium text-text mb-1.5">
              Recruiter / contact email <span className="text-text-3 font-normal">(optional)</span>
            </label>
            <input
              id="job-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane.recruiter@company.com"
              className="w-full bg-white border border-[var(--border)] rounded-md px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
            />
            <p className="text-[11px] text-text-2 mt-1.5">
              Used later for sending your tailored CV via email — kept private on your account.
            </p>
          </div>

          {/* Hiring Manager */}
          <div>
            <label htmlFor="hiring-manager" className="block text-[12px] font-medium text-text mb-1.5">
              Hiring manager name <span className="text-text-3 font-normal">(optional)</span>
            </label>
            <input
              id="hiring-manager"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={hiringMgr}
              onChange={(e) => setHiringMgr(e.target.value)}
              placeholder="John Smith"
              className="w-full bg-white border border-[var(--border)] rounded-md px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
            />
            <p className="text-[11px] text-text-2 mt-1.5">
              Used in the cover letter salutation (e.g., "Dear John Smith,").
            </p>
          </div>

          {error && (
            <div className="rounded-md bg-[#FFEBE9] border border-[#CF222E]/30 px-3 py-2 text-[12px] text-[#CF222E]">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border)] flex gap-2 justify-end bg-[var(--surface-2)] rounded-b-lg">
          <button onClick={onClose} disabled={busy} className="gh-btn text-[13px]">Cancel</button>
          <button
            onClick={save}
            disabled={busy}
            className="gh-btn gh-btn-primary text-[13px]"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
