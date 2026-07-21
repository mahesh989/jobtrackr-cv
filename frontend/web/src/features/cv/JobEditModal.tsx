"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, Textarea, Input } from "@/components/ui";
import { triggerReanalyze } from "@/features/cv/analysis/AnalyzeJobButton";
import { MANUAL_JD_MIN_CHARS } from "@/features/jobs/lib/jobFilters";
import { matchedExclusions } from "@/lib/descExclusion";

interface Props {
  jobId:              string;
  jobUrl?:            string | null;
  originalJd:         string;
  initialManual:      string | null;
  initialEmail:       string | null;
  initialHiringMgr:   string | null;
  initialCompanyAddress: string | null;
  excludeKeywords?:   string;
  onClose():          void;
  onSaved(patch: {
    manual_jd_text:  string | null;
    contact_email:   string | null;
    hiring_manager:  string | null;
    company_address: string | null;
  }): void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function JobEditModal({
  jobId, jobUrl, originalJd, initialManual, initialEmail, initialHiringMgr, initialCompanyAddress, excludeKeywords, onClose, onSaved,
}: Props) {
  const [text, setText]       = useState<string>(initialManual ?? originalJd ?? "");
  const [email, setEmail]     = useState<string>(initialEmail ?? "");
  const [hiringMgr, setHiringMgr] = useState<string>(initialHiringMgr ?? "");
  const [companyAddress, setCompanyAddress] = useState<string>(initialCompanyAddress ?? "");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [confirmExclusion, setConfirmExclusion] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const router = useRouter();

  const exclusionHits = useMemo(
    () => matchedExclusions(text, excludeKeywords ?? ""),
    [text, excludeKeywords],
  );

  const wasOriginallyEdited = initialManual !== null && initialManual !== "";

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  function handleSave() {
    if (exclusionHits.length > 0 && !confirmExclusion) {
      setConfirmExclusion(true);
      return;
    }
    void save();
  }

  async function save() {
    setError(null);
    setBusy(true);
    setConfirmExclusion(false);

    const trimmedText  = text.trim();
    const trimmedEmail = email.trim();
    const trimmedHiringMgr = hiringMgr.trim();
    const trimmedAddress   = companyAddress.trim();

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
          manual_jd_text:  manualForApi,
          contact_email:   trimmedEmail === "" ? null : trimmedEmail,
          hiring_manager:  trimmedHiringMgr === "" ? null : trimmedHiringMgr,
          company_address: trimmedAddress === "" ? null : trimmedAddress,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Failed (${res.status})`);
        setBusy(false);
        return;
      }
      onSaved({
        manual_jd_text:  json.manual_jd_text ?? null,
        contact_email:   json.contact_email ?? null,
        hiring_manager:  json.hiring_manager ?? null,
        company_address: json.company_address ?? null,
      });
      onClose();

      // Auto-analyse when the freshly-pasted JD has cleared the manual-JD
      // floor — this is what makes a thin-JD job actionable. Skipping this
      // for sub-floor pastes (still effectively thin) preserves the
      // existing UX where the user explicitly clicks Analyze after curating.
      const hasUsableJd =
        manualForApi !== null && manualForApi.length >= MANUAL_JD_MIN_CHARS;

      if (hasUsableJd) {
        // Fire the per-card spinner immediately — listening AnalyzeJobButton
        // for this jobId will switch to "Analysing…" without waiting for the
        // fetch to land. Failure dispatches a "failed" event that clears it.
        window.dispatchEvent(new CustomEvent("jobtrackr:analysis-started", { detail: { jobId } }));
        triggerReanalyze(jobId)
          .then(() => {
            // Once the run row is created, refresh the board so the card
            // picks up has_analysis = true on completion. The board is
            // wired to Realtime postgres_changes on analysis_runs, so the
            // refresh just primes the initial server payload; subsequent
            // step transitions land via Realtime.
            router.refresh();
          })
          .catch((err) => {
            console.error("[JobEditModal] auto-analyse failed:", err);
            window.dispatchEvent(new CustomEvent("jobtrackr:analysis-failed", { detail: { jobId } }));
          });
      } else {
        // No auto-analyse — keep the legacy delayed refresh so the jd_quality
        // recompute (DB trigger) clears the stale "thin JD" badge.
        setTimeout(() => router.refresh(), 1900);
      }
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

  return (
    <Modal open onClose={onClose} size="lg" className="max-h-[90vh]">
      <div className="px-5 py-4 border-b border-[var(--border)]">
        <h2 className="text-[15px] font-semibold text-text">Edit job inputs</h2>
        <p className="text-label text-text-2 mt-0.5 leading-snug">
          Trim out the noise — company blurb, EEO statement, benefits — so the
          AI focuses on responsibilities and skills. The original scrape is
          preserved either way.
        </p>
        {jobUrl && (
          <a
            href={jobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-2 text-label font-medium text-[var(--brand)] hover:underline"
            title="Open the live job posting in a new tab to copy the full description"
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Open original job posting
          </a>
        )}
      </div>

        <div className="px-5 py-4 overflow-y-auto space-y-5 flex-1">
          {/* JD text */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-caption text-text-2 tabular-nums">
                {charCount.toLocaleString()} chars · {wordCount.toLocaleString()} words
              </span>
            </div>
            <Textarea
              label="Job description (what the AI will see)"
              id="jd-edit"
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={16}
              spellCheck={false}
              className="bg-[var(--surface-2)] border-[var(--border)] rounded-md px-3 py-2 text-label placeholder:text-text-3 leading-relaxed font-mono focus:ring-2 focus:ring-[var(--brand)]/30 resize-y"
            />
            <div className="flex items-center gap-3 mt-1.5">
              <button onClick={resetToOriginal} disabled={busy} className="text-caption text-[var(--brand)] hover:underline" title="Replace the editor contents with the original scraped description">
                Reset to original scrape
              </button>
              {wasOriginallyEdited && (
                <span className="text-caption text-[var(--amber)] bg-[var(--amber)]/12 border border-[var(--amber)]/40 px-1.5 py-0.5 rounded">
                  Edited JD active
                </span>
              )}
            </div>
          </div>

          {/* Email */}
          <div>
            <Input
              label="Recruiter / contact email (optional)"
              id="job-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane.recruiter@company.com"
            />
            <p className="text-caption text-text-2 mt-1.5">
              Used later for sending your tailored CV via email — kept private on your account.
            </p>
          </div>

          {/* Hiring Manager */}
          <div>
            <Input
              label="Hiring manager name (optional)"
              id="hiring-manager"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={hiringMgr}
              onChange={(e) => setHiringMgr(e.target.value)}
              placeholder="John Smith"
            />
            <p className="text-caption text-text-2 mt-1.5">
              Used in the cover letter salutation (e.g., &ldquo;Dear John Smith,&rdquo;).
            </p>
          </div>

          {/* Company Address */}
          <div>
            <Textarea
              label="Company address (optional, multi-line)"
              id="company-address"
              value={companyAddress}
              onChange={(e) => setCompanyAddress(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={"Level 10, 123 Pitt Street\nSydney NSW 2000"}
              className="bg-[var(--surface-2)] border-[var(--border)] rounded-md px-3 py-2 text-body placeholder:text-text-3 focus:ring-2 focus:ring-[var(--brand)]/30 resize-y"
            />
            <p className="text-caption text-text-2 mt-1.5">
              Appears in the cover letter employer block beneath the company name. Leave blank to omit.
            </p>
          </div>

          {exclusionHits.length > 0 && (
            <div className="rounded-md bg-[var(--amber)]/12 border border-[var(--amber)]/40 px-3 py-2">
              <p className="text-label font-medium text-[var(--amber)]">
                This JD matches {exclusionHits.length} exclusion{exclusionHits.length > 1 ? "s" : ""} from your profile settings
              </p>
              <p className="text-caption text-text-2 mt-1">
                {exclusionHits.map((h) => (
                  <span key={h} className="inline-block bg-[var(--amber)]/15 border border-[var(--amber)]/30 rounded px-1.5 py-0.5 mr-1.5 mb-1 text-[var(--amber)] font-medium">
                    {h}
                  </span>
                ))}
              </p>
              <p className="text-caption text-text-3 mt-1">
                The scraping pipeline would have filtered this job out. You can still save and analyse it.
              </p>
            </div>
          )}

          {confirmExclusion && (
            <div className="rounded-md bg-[var(--amber)]/8 border border-[var(--amber)]/40 px-3 py-3">
              <p className="text-label font-medium text-text mb-2">
                Save anyway? This JD contains excluded phrases.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="brand"
                  size="sm"
                  onClick={() => void save()}
                >
                  Save &amp; analyse anyway
                </Button>
                <Button
                  size="sm"
                  onClick={() => setConfirmExclusion(false)}
                >
                  Go back
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-[var(--red)]/12 border border-[var(--red)]/30 px-3 py-2 text-label text-[var(--red)]">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border)] flex gap-2 justify-end bg-[var(--surface-2)] rounded-b-lg">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="brand"
            onClick={handleSave}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
    </Modal>
  );
}
