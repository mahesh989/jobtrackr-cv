"use client";

/**
 * More tab — Downloads (a single "Download ZIP" when both CV + cover letter
 * exist, else a single CV download) leads, Email message follows. Matches
 * the mockup's final ordering: user explicitly asked for downloads first and
 * a single ZIP option rather than three separate rows.
 *
 * Email section forks on whether the job has a contact_email on file:
 *   - has one  → recipient shown, "Send email" available (via the existing
 *                applications send-email route), "Change" reveals an inline
 *                input (PATCH /api/jobs/[id]).
 *   - no email → explains apply-via-listing, offers "+ Add email" (same
 *                inline input/PATCH), still shows the drafted message to copy.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { downloadApplicationBundle } from "@/lib/downloadZip";
import { useTailoredCvPdfAction } from "./useTailoredCvPdfAction";
import type { BoardJob } from "../../lib/jobFilters";
import type { BoardDetailRun, BoardDetailCoverLetter } from "../../lib/boardDetailTypes";

interface EmailDraft {
  to: string;
  to_email: string | null;
  subject: string;
  body: string;
}

export function MoreTab({
  job, run, letter,
}: {
  job:    BoardJob;
  run:    BoardDetailRun;
  letter: BoardDetailCoverLetter | null;
}) {
  const hasCv     = !!run.tailored_cv_storage_path;
  const hasLetter = !!letter?.pass_3_final;
  const { downloadPdf, pending: cvPending } = useTailoredCvPdfAction(run.tailored_cv_storage_path);

  const [zipPending, setZipPending] = useState(false);
  const [zipError, setZipError]     = useState<string | null>(null);

  async function handleDownloadZip() {
    if (!letter || !run.tailored_cv_storage_path || zipPending) return;
    setZipPending(true); setZipError(null);
    try {
      await downloadApplicationBundle({
        jobId:         job.id,
        letterId:      letter.id,
        cvStoragePath: run.tailored_cv_storage_path,
        companyName:   job.company,
        hiringManager: job.hiring_manager ?? null,
      });
    } catch (e) {
      setZipError(e instanceof Error ? e.message : "Could not build ZIP");
    } finally {
      setZipPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mb-2">Downloads</h4>
        {hasCv && hasLetter ? (
          <DownloadRow
            label="Tailored CV + cover letter"
            sub={`Both files, zipped${run.tailored_match_score != null ? ` · ATS ${run.tailored_match_score}` : ""}`}
            actionLabel="⤓ Download ZIP"
            pending={zipPending}
            onClick={handleDownloadZip}
          />
        ) : hasCv ? (
          <>
            <DownloadRow
              label="Tailored CV"
              sub={`PDF${run.tailored_match_score != null ? ` · ATS ${run.tailored_match_score}` : ""}`}
              actionLabel="⤓ Download PDF"
              pending={cvPending === "download"}
              onClick={() => downloadPdf(`tailored-cv-${job.id.slice(0, 8)}`)}
            />
            <p className="text-label text-text-3 mt-2">
              {hasLetter ? "" : "No cover letter exists yet for this run — only a tailored CV."}
            </p>
          </>
        ) : (
          <p className="text-label text-text-3 italic">No files to download yet.</p>
        )}
        {zipError && <p className="text-label text-red-600 mt-2">{zipError}</p>}
      </section>

      {letter && (
        <EmailSection job={job} letterId={letter.id} />
      )}
    </div>
  );
}

function DownloadRow({
  label, sub, actionLabel, pending, onClick,
}: { label: string; sub: string; actionLabel: string; pending: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-[#fafbfc] px-3.5 py-3 mb-2">
      <div>
        <p className="text-[13.5px] font-semibold text-text">{label}</p>
        <p className="text-[12px] text-text-3 mt-0.5">{sub}</p>
      </div>
      <Button variant="brand" size="sm" onClick={onClick} disabled={pending}>
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : actionLabel}
      </Button>
    </div>
  );
}

function EmailSection({ job, letterId }: { job: BoardJob; letterId: string }) {
  const [draft, setDraft]         = useState<EmailDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddEmail, setShowAddEmail] = useState(false);
  const [emailInput, setEmailInput]     = useState(job.contact_email ?? "");
  const [savingEmail, setSavingEmail]   = useState(false);
  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [sending, setSending]     = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent]           = useState(false);
  const [editing, setEditing]     = useState(false);
  const [editBody, setEditBody]   = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/applications/${letterId}/email-draft`);
        if (!active) return;
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setLoadError(j.error ?? "Could not load the drafted email");
          return;
        }
        const json = await res.json();
        setDraft({ to: json.to, to_email: json.to_email, subject: json.subject, body: json.body });
        setEditBody(json.body ?? "");
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => { active = false; };
  }, [letterId]);

  async function saveEmail() {
    const trimmed = emailInput.trim();
    if (!trimmed || savingEmail) return;
    setSavingEmail(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contact_email: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Could not save email");
      }
      setContactEmail(trimmed);
      setShowAddEmail(false);
    } catch {
      // Inline errors would need more UI real estate than this warrants —
      // the input just stays open so the user can retry.
    } finally {
      setSavingEmail(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try { await navigator.clipboard.writeText(draft.body); } catch { /* clipboard may be unavailable */ }
  }

  async function sendEmail() {
    if (sending) return;
    setSending(true); setSendError(null);
    try {
      const res = await fetch(`/api/applications/${letterId}/send-email`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Send failed (${res.status})`);
      }
      setSent(true);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Could not send email");
    } finally {
      setSending(false);
    }
  }

  return (
    <section>
      <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mb-2">Email message</h4>

      {contactEmail ? (
        <div className="flex items-center gap-2 text-label mb-3 flex-wrap">
          <span className="text-text-3">To:</span>
          <span className="font-semibold text-text">{contactEmail}</span>
          <button type="button" onClick={() => setShowAddEmail((v) => !v)} className="text-[var(--brand)] hover:underline font-medium">
            Change
          </button>
        </div>
      ) : (
        <div className="rounded-[10px] bg-[#f7f8fa] border border-border px-3.5 py-2.5 mb-3 text-[14px] text-text-2">
          <p><b className="text-text">No contact email on file</b> for this listing — apply via the job posting instead. You can still copy the message below into your own email, or add a contact email if you find one.</p>
        </div>
      )}

      {!contactEmail && !showAddEmail && (
        <Button size="sm" className="mb-3" onClick={() => setShowAddEmail(true)}>+ Add email</Button>
      )}

      {showAddEmail && (
        <div className="flex items-center gap-2 mb-3">
          <input
            type="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="contact@company.com"
            className="field text-label py-1.5 max-w-xs"
          />
          <Button variant="brand" size="sm" onClick={saveEmail} disabled={savingEmail || !emailInput.trim()}>
            {savingEmail ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
        </div>
      )}

      {loadError && <p className="text-label text-red-600">{loadError}</p>}

      {draft && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-label text-text-2">CV + cover letter will be attached</span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={copyDraft}>Copy</Button>
              <Button size="sm" onClick={() => { setEditing(!editing); if (!editing) setEditBody(draft.body); }}>
                {editing ? "Done" : "Edit"}
              </Button>
              {contactEmail && (
                <Button variant="brand" size="sm" onClick={sendEmail} disabled={sending || sent}>
                  {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : sent ? "Sent ✓" : "Send email"}
                </Button>
              )}
            </div>
          </div>
          {sendError && <p className="text-label text-red-600 mb-2">{sendError}</p>}
          {editing ? (
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              className="w-full rounded-[10px] border border-border bg-white px-[22px] py-5 text-[14px] text-text leading-relaxed resize-y min-h-[200px]"
            />
          ) : (
            <div className="rounded-[10px] border border-border bg-[#fafbfc] px-[22px] py-5 max-h-[400px] overflow-y-auto">
              <p className="text-[14px] text-text whitespace-pre-wrap leading-relaxed">{draft.body}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
