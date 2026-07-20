"use client";

/**
 * CardV2 — the redesigned card used by the new 2-tab Applications
 * screen. Two variants behind one component:
 *
 *   Pool variant  (tab="pool") — expandable big card. Click to open, then use
 *     section tabs (Tailored CV / Cover letter / Email message) to review
 *     everything in one place. Cover letter and email message are inline-
 *     editable with explicit Save buttons. Action bar exposes the document
 *     buttons (Cover letter PDF, Tailored CV PDF, Download ZIP) and the
 *     channel-adaptive send/apply action.
 *
 *   Sent variant  (tab="sent") — minimal done card. Surfaces a popup with the
 *     email message + Copy button so the user can revisit later.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown, ChevronRight, Mail, ExternalLink, FileText, FileType,
  Copy, Check, CheckCircle2, Archive, Loader2, Send, Save, Download,
  Sparkles, MoreHorizontal,
} from "lucide-react";
import { Badge, MenuItem, menuItemClass, SegmentedControl, IconButton } from "@/components/ui";
import { markJobApplied, markJobDismissed, markJobUnapplied } from "@/lib/actions";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { renderTailoredCvBlob } from "@/lib/cvPdfRender";
import type { ContactDetails } from "@/lib/types";
import { downloadApplicationBundle } from "@/lib/downloadZip";
import { CvInlinePreview } from "./CvInlinePreview";
import { SentEmailModal } from "./SentEmailModal";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Input, Textarea } from "@/components/ui";
import { relativeDate } from "@/lib/dates";
import { useCoverLetter } from "../hooks/useCoverLetter";
import { useEmailDraft } from "../hooks/useEmailDraft";
import { useContactEmail } from "../hooks/useContactEmail";

function presentBlob(win: Window | null, blob: Blob, filename: string): "tab" | "download" {
  const url = URL.createObjectURL(blob);
  if (win && !win.closed) {
    win.location.replace(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "tab";
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "download";
}

async function loadCvInputs(
  storagePath: string,
): Promise<{ markdown: string; contactDetails: ContactDetails | null }> {
  const supabase = createSupabaseClient();
  const [{ data: mdBlob, error: dlErr }, prefsRes] = await Promise.all([
    supabase.storage.from("tailored-cvs").download(storagePath),
    fetch("/api/user/preferences"),
  ]);
  if (dlErr || !mdBlob) throw new Error(dlErr?.message ?? "Couldn't load CV markdown");
  const markdown = await mdBlob.text();
  let contactDetails: ContactDetails | null = null;
  if (prefsRes.ok) {
    const json = await prefsRes.json();
    if (json?.contact_details) {
      const cd = { ...json.contact_details };
      delete cd.projects;
      contactDetails = cd as ContactDetails;
    }
  }
  return { markdown, contactDetails };
}

export interface ApplicationRowV2 {
  letter_id:                 string | null;
  letter_completed_at:       string | null;
  job_id:                    string;
  job_title:                 string;
  job_company:               string;
  job_location:              string;
  job_url:                   string;
  job_applied_at:            string | null;
  job_dismissed_at:          string | null;
  job_contact_email:         string | null;
  job_hiring_manager:        string | null;
  job_posted_at:             string | null;
  job_distance_km:           number | null;
  analyzed_at:               string | null;
  profile_id:                string;
  profile_name:              string;
  latest_run_id:             string | null;
  tailored_match_score:      number | null;
  tailored_pdf_storage_path: string | null;
  tailored_cv_storage_path:  string | null;
}

export type CardTabV2 = "pool" | "sent";

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

function scoreColor(n: number | null) {
  if (n == null) return "text-text-3";
  if (n >= 75) return "text-emerald-600";
  if (n >= 55) return "text-amber-600";
  return "text-red-600";
}

// ── Tailored CV inline PDF ──────────────────────────────────────────────

type CvPdfState = "idle" | "preparing" | "ready" | "error";

function useTailoredCvPdf(row: ApplicationRowV2, onError?: (msg: string) => void) {
  const [state, setState] = useState<CvPdfState>("idle");
  const started = useRef(false);
  const url = row.letter_id ? `/api/applications/${row.letter_id}/tailored-cv-pdf` : null;

  const ensure = useCallback(async () => {
    if (!url || !row.tailored_cv_storage_path) return;
    if (started.current) return;
    started.current = true;
    setState("preparing");
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) { setState("ready"); return; }
      const { markdown, contactDetails } = await loadCvInputs(row.tailored_cv_storage_path);
      const blob = await renderTailoredCvBlob({ markdown, contactDetails });
      const res = await fetch(url, {
        method:  "PUT",
        headers: { "Content-Type": "application/pdf" },
        body:    blob,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Could not prepare CV (${res.status})`);
      }
      setState("ready");
    } catch (e) {
      started.current = false;
      setState("error");
      onError?.(e instanceof Error ? e.message : "Could not prepare tailored CV PDF");
    }
  }, [url, row.tailored_cv_storage_path, onError]);

  return { state, url, ensure };
}

function TailoredCvButton({ cvPdf }: { cvPdf: ReturnType<typeof useTailoredCvPdf> }) {
  const { state, url, ensure } = cvPdf;
  if (!url) return null;

  if (state === "ready") {
    return (
      <Button asChild variant="default" size="xs">
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1"
          title="Open tailored CV PDF in new tab">
          <FileText className="w-3 h-3" /> Tailored CV
        </a>
      </Button>
    );
  }
  if (state === "error") {
    return (
      <Button onClick={ensure}
        size="xs"
        icon={<FileText className="w-3 h-3" />}
        title="Preparing the CV PDF failed — click to retry">
        Tailored CV
      </Button>
    );
  }
  return (
    <Button disabled isLoading
      size="xs"
      title="Preparing tailored CV PDF…">
      Tailored CV
    </Button>
  );
}

// ── Entry point ─────────────────────────────────────────────────────────

export function CardV2({
  row, tab, onActioned,
}: {
  row: ApplicationRowV2;
  tab: CardTabV2;
  onActioned?: () => void;
}) {
  return tab === "pool"
    ? <PoolCard row={row} onActioned={onActioned} />
    : <SentCard row={row} onActioned={onActioned} />;
}

// ── Pool card ───────────────────────────────────────────────────────────

function PoolCard({ row, onActioned }: { row: ApplicationRowV2; onActioned?: () => void }) {
  const router = useRouter();

  const [open, setOpen]             = useState(false);
  const [section, setSection]       = useState<"cv" | "cover" | "email">("cv");
  const [hidden, setHidden]         = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const cover   = useCoverLetter(row.letter_id, setActionError);
  const email   = useEmailDraft(row.letter_id, setActionError);
  const contact = useContactEmail(row.job_contact_email, row.job_id, row.profile_id, setActionError);

  const [sending, setSending]       = useState(false);
  const [copied, setCopied]         = useState(false);
  const [zipping, setZipping]       = useState(false);
  const [emailFallback, setEmailFallback] = useState<{ subject: string; body: string } | null>(null);

  const hasEmail = !!contact.email;

  const cvPdf = useTailoredCvPdf(row, setActionError);
  const ensureCvPdf = cvPdf.ensure;
  useEffect(() => { if (open) ensureCvPdf(); }, [open, ensureCvPdf]);

  const analysisHref = row.latest_run_id
    ? `/jobs/${row.job_id}/analyze/${row.latest_run_id}`
    : null;

  async function handleSendEmail() {
    if (sending) return;
    if (email.dirty) { setActionError("Save your email changes before sending."); return; }
    if (!row.tailored_cv_storage_path) { setActionError("No tailored CV available to attach."); return; }
    setActionError(null);
    setSending(true);
    try {
      const supabase = createSupabaseClient();
      const [{ data: mdBlob, error: mdErr }, prefsRes] = await Promise.all([
        supabase.storage.from("tailored-cvs").download(row.tailored_cv_storage_path),
        fetch("/api/user/preferences"),
      ]);
      if (mdErr || !mdBlob) throw new Error(mdErr?.message ?? "Couldn't load CV markdown");
      const markdown = await mdBlob.text();
      let contactDetails: ContactDetails | null = null;
      if (prefsRes.ok) {
        const json = await prefsRes.json();
        if (json?.contact_details) {
          const cd = { ...json.contact_details };
          delete cd.projects;
          contactDetails = cd as ContactDetails;
        }
      }
      const pdfBlob = await renderTailoredCvBlob({ markdown, contactDetails });
      const form = new FormData();
      const slug = (row.job_company || "company").replace(/[^a-zA-Z0-9]/g, "_");
      form.set("cv_pdf", pdfBlob, `TailoredCV_${slug}.pdf`);
      const res  = await fetch(`/api/applications/${row.letter_id}/send-email`, { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? "Send failed"); return; }
      setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 600);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  }

  async function handleCopyEmail() {
    if (copied) return;
    setActionError(null);
    const payload = `Subject: ${email.subject}\n\n${email.body}`;
    const ok = await copyToClipboard(payload);
    if (!ok) { setEmailFallback({ subject: email.subject, body: email.body }); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const [, startTransition] = useTransition();

  function handleApplyNow() {
    if (sending) return;
    window.open(row.job_url, "_blank", "noopener,noreferrer");
    setSending(true);
    startTransition(async () => {
      try { await markJobApplied(row.job_id, row.profile_id); }
      catch (e) { console.error(e); setActionError("Failed to mark applied"); }
      finally   {
        setSending(false);
        setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 500);
      }
    });
  }

  function handleArchive() {
    if (sending) return;
    setSending(true);
    startTransition(async () => {
      try { await markJobDismissed(row.job_id, row.profile_id); }
      catch (e) { console.error(e); setActionError("Failed to archive"); }
      finally   {
        setSending(false);
        setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 400);
      }
    });
  }

  async function handleDownloadZip() {
    if (zipping) return;
    setActionError(null);
    setZipping(true);
    try {
      if (!row.tailored_cv_storage_path) throw new Error("Tailored CV is not available");
      if (!row.letter_id) throw new Error("Cover letter is not available");
      await downloadApplicationBundle({
        jobId: row.job_id, letterId: row.letter_id, cvStoragePath: row.tailored_cv_storage_path,
        companyName: row.job_company, hiringManager: row.job_hiring_manager,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to download ZIP bundle");
    } finally { setZipping(false); }
  }

  if (hidden) return null;

  return (
    <div className="bg-surface border border-border rounded-md anim-in hover:border-[var(--text-3)] transition-colors">
      {/* Collapsed summary */}
      <div className="flex items-center gap-1 pr-3">
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 flex items-center gap-3 pl-4 pr-1 py-3 text-left">
          {open ? <ChevronDown className="w-4 h-4 text-text-3 shrink-0" /> : <ChevronRight className="w-4 h-4 text-text-3 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-text truncate">{row.job_title}</p>
            <p className="text-[12px] text-text-2 truncate mt-0.5">
              {row.job_company || "—"}{row.job_location && ` · ${row.job_location}`}{row.profile_name && ` · via ${row.profile_name}`}
            </p>
            {(row.job_distance_km != null || row.job_posted_at) && (
              <p className="text-[11px] text-text-3 mt-0.5">
                {[
                  row.job_distance_km != null ? `${Math.round(row.job_distance_km)} km away` : null,
                  row.job_posted_at ? `Posted ${relativeDate(row.job_posted_at)}` : null,
                ].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {hasEmail && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-text-3">
                <Mail className="w-3 h-3 text-[var(--brand)]" /> Email ready
              </span>
            )}
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-text-3">Tailored</p>
              <p className={`text-[18px] font-bold tabular-nums ${scoreColor(row.tailored_match_score)}`}>
                {row.tailored_match_score == null ? "—" : Math.round(row.tailored_match_score)}
                {row.tailored_match_score != null && <span className="text-[11px] text-text-3 font-medium">/100</span>}
              </p>
            </div>
          </div>
        </button>
        <a href={row.job_url} target="_blank" rel="noopener noreferrer" title="Open job posting"
          className="p-1.5 rounded-md text-text-3 hover:text-[var(--brand)] hover:bg-[var(--surface-2)] transition-colors shrink-0">
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>

      {open && (
        <>
          {/* Channel chip */}
          <div className="px-4 pb-2 border-t border-border pt-3">
            <div className="flex items-center gap-2 flex-wrap text-[12px]">
              {hasEmail ? (
                <span className="inline-flex items-center gap-1.5 text-text-2">
                  <Mail className="w-3.5 h-3.5 text-[var(--brand)]" />
                  <span className="font-medium">To:</span>
                  {contact.editing ? (
                    <Input autoFocus type="email" value={contact.draft}
                      onChange={(e) => contact.setDraft(e.target.value)}
                      onBlur={() => contact.commit(contact.draft)}
                      onKeyDown={(e) => { if (e.key === "Enter") contact.commit(contact.draft); }}
                      aria-label="Contact email"
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] w-56" />
                  ) : (
                    <button onClick={() => { contact.setDraft(contact.email ?? ""); contact.setEditing(true); }}
                      className="font-mono text-[11px] hover:text-text underline decoration-dotted">
                      {contact.email}
                    </button>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-text-3">
                  <ExternalLink className="w-3.5 h-3.5" />
                  No contact email — copy the message and apply via the job link
                  {!contact.editing && (
                    <button onClick={() => { contact.setDraft(""); contact.setEditing(true); }}
                      className="text-[var(--brand)] hover:underline ml-1">add email</button>
                  )}
                </span>
              )}
              {!hasEmail && contact.editing && (
                <Input autoFocus type="email" placeholder="hr@company.com" value={contact.draft}
                  onChange={(e) => contact.setDraft(e.target.value)}
                  onBlur={() => contact.commit(contact.draft)}
                  onKeyDown={(e) => { if (e.key === "Enter") contact.commit(contact.draft); }}
                  aria-label="Contact email"
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] w-56" />
              )}
              {email.voiceRewritten && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-600 text-white">
                  <Sparkles className="w-3 h-3" /> Personalised in your voice
                </span>
              )}
              <span className="text-[11px] text-text-3 ml-auto">
                Cover letter generated {relativeDate(row.letter_completed_at) ?? "—"}
              </span>
            </div>
          </div>

          {/* Section toggle */}
          <div className="px-4 pt-2 pb-1 overflow-x-auto">
            <SegmentedControl
              size="sm"
              value={section}
              onChange={setSection}
              options={[
                {
                  id: "cv", label: "Tailored CV", icon: <FileText className="w-3 h-3" />,
                },
                {
                  id: "cover", icon: <FileType className="w-3 h-3" />,
                  label: <>Cover letter{cover.dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />}</>,
                },
                {
                  id: "email", icon: <Mail className="w-3 h-3" />,
                  label: <>Email message{email.dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />}</>,
                },
              ]}
            />
          </div>

          {/* Section body */}
          <div className="px-4 py-3">
            {section === "cv" && <CvInlinePreview storagePath={row.tailored_cv_storage_path} />}

            {section === "cover" && (
              <div className="space-y-2">
                {cover.loading ? (
                  <div className="py-8 flex items-center justify-center text-text-3 text-[12px]">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading cover letter…
                  </div>
                ) : (
                  <>
                    <Textarea label="Cover letter" value={cover.text} onChange={(e) => cover.setText(e.target.value)} disabled={cover.saving} rows={14}
                      className="text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60" spellCheck />
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-3">
                        {cover.text.length} chars{cover.dirty && " · unsaved changes"}
                      </span>
                      {cover.dirty && (
                        <Button variant="brand" size="xs" onClick={cover.save} disabled={cover.saving} isLoading={cover.saving}
                          icon={<Save className="w-3 h-3" />}
                          className="ml-auto">
                          {cover.saving ? "Saving…" : "Save changes"}
                        </Button>
                      )}
                    </div>
                    <p className="text-[10px] text-text-3">
                      Changes update the letter body, the downloadable PDF, and what gets attached to emails.
                    </p>
                  </>
                )}
              </div>
            )}

            {section === "email" && (
              <div className="space-y-2">
                {email.loading ? (
                  <div className="py-8 flex items-center justify-center text-text-3 text-[12px]">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading email draft…
                  </div>
                ) : (
                  <>
                    <div>
                      <Input label="Subject" value={email.subject} onChange={(e) => email.setSubject(e.target.value)} disabled={email.saving} maxLength={300}
                        className="text-[13px]" />
                    </div>
                    <div>
                      <Textarea label="Message to the employer" value={email.body} onChange={(e) => email.setBody(e.target.value)} disabled={email.saving} rows={7} maxLength={20_000}
                        className="text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60" spellCheck />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-3">{email.dirty ? "Unsaved changes" : "Saved"}</span>
                      {email.dirty && (
                        <Button variant="brand" size="xs" onClick={email.save} disabled={email.saving} isLoading={email.saving}
                          icon={<Save className="w-3 h-3" />}
                          className="ml-auto">
                          {email.saving ? "Saving…" : "Save changes"}
                        </Button>
                      )}
                    </div>
                    <p className="text-[10px] text-text-3">
                      Save your edits before sending. Tailored CV + cover letter are attached as PDFs — keep this body short.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>

          {actionError && <ErrorBanner message={actionError} />}

          {emailFallback && (
            <div className="mx-4 mb-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
              <p className="text-[11px] text-text-2 mb-2">Clipboard blocked — select all and copy manually:</p>
              <textarea readOnly rows={7}
                className="w-full text-[11px] font-mono text-text bg-surface border border-[var(--border)] rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                value={`Subject: ${emailFallback.subject}\n\n${emailFallback.body}`}
                onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => setEmailFallback(null)} className="mt-1 text-[11px] text-text-3 hover:text-text">Dismiss</button>
            </div>
          )}

          {/* Action bar */}
          <div className="px-4 py-3 border-t border-border flex items-center gap-2 flex-wrap">
            <Button asChild variant="default" size="xs">
              <a href={`/api/applications/${row.letter_id}/cover-letter-pdf`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1" title="Open cover letter PDF in new tab">
                <FileType className="w-3 h-3" /> Cover letter
              </a>
            </Button>
            {row.tailored_cv_storage_path && <TailoredCvButton cvPdf={cvPdf} />}
            {row.tailored_cv_storage_path && (
              <Button onClick={handleDownloadZip} disabled={zipping} isLoading={zipping}
                size="xs"
                icon={<Download className="w-3 h-3" />}
                title="Download CV + cover letter as a ZIP">
                Download ZIP
              </Button>
            )}
            <div className="w-px h-5 bg-[var(--border)] mx-1" />
            {hasEmail ? (
              <Button variant="brand" size="sm" onClick={handleSendEmail} disabled={sending || email.dirty} isLoading={sending}
                icon={<Send className="w-3.5 h-3.5" />}
                title={email.dirty ? "Save your email changes first" : "Send the email with the attached CV"}>
                {sending ? "Sending…" : "Send email"}
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={handleCopyEmail} disabled={!email.loaded || email.dirty}
                  icon={copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  title={email.dirty ? "Save your email changes first" : "Copy subject + body to clipboard"}>
                  {copied ? "Copied" : "Copy email"}
                </Button>
                <Button variant="brand" size="sm" onClick={handleApplyNow} disabled={sending}
                  icon={<ExternalLink className="w-3.5 h-3.5" />}
                  title="Open the job posting and mark this as applied">
                  Apply now
                </Button>
              </>
            )}
            <PoolOverflowMenu
              row={row} analysisHref={analysisHref} sending={sending} onArchive={handleArchive} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Pool overflow menu (···) ────────────────────────────────────────────

function PoolOverflowMenu({ row, analysisHref, sending, onArchive }: {
  row: ApplicationRowV2;
  analysisHref: string | null;
  sending: boolean;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative ml-auto">
      <IconButton onClick={() => setOpen((m) => !m)} icon={<MoreHorizontal className="w-4 h-4" />}
        aria-label="More actions" title="More actions" />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full mb-1 w-48 bg-surface border border-border rounded-md shadow-lg py-1 z-20">
            {analysisHref && (
              <Link href={analysisHref} className={menuItemClass()}>
                <FileText className="w-3.5 h-3.5" /> Full analysis
              </Link>
            )}
            <a href={row.job_url} target="_blank" rel="noopener noreferrer" className={menuItemClass()}>
              <ExternalLink className="w-3.5 h-3.5" /> Open job posting
            </a>
            <div className="border-t border-border my-1" />
            <MenuItem danger onClick={() => { setOpen(false); onArchive(); }} disabled={sending}>
              <Archive className="w-3.5 h-3.5" /> Archive
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sent / Applied card ─────────────────────────────────────────────────

function SentCard({ row, onActioned }: { row: ApplicationRowV2; onActioned?: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [showEmail, setShowEmail]       = useState(false);
  const [hidden, setHidden]             = useState(false);
  const [zipping, setZipping]           = useState(false);
  const [movingBack, setMovingBack]     = useState(false);
  const [actionError, setActionError]   = useState<string | null>(null);
  const [cvPreviewing, setCvPreviewing] = useState(false);

  const isApplied  = !!row.job_applied_at;
  const isArchived = !!row.job_dismissed_at && !isApplied;

  const cvPdf = useTailoredCvPdf(row, setActionError);
  const ensureCvPdf = cvPdf.ensure;
  useEffect(() => { if (row.letter_id) ensureCvPdf(); }, [row.letter_id, ensureCvPdf]);

  async function previewTailoredCv() {
    if (cvPreviewing || !row.tailored_cv_storage_path) return;
    const win = window.open("", "_blank");
    if (win) {
      try { win.document.write("<html><body style='font-family:sans-serif;padding:20px;color:#888'><p>Rendering tailored CV…</p></body></html>"); } catch { /* ignore */ }
    }
    setCvPreviewing(true);
    setActionError(null);
    try {
      const { markdown, contactDetails } = await loadCvInputs(row.tailored_cv_storage_path);
      const pdfBlob = await renderTailoredCvBlob({ markdown, contactDetails });
      const how = presentBlob(win, pdfBlob, "tailored-cv.pdf");
      if (how === "download") setActionError("Popups are blocked, so the CV was downloaded instead.");
    } catch (e) {
      try { win?.close(); } catch { /* ignore */ }
      setActionError(e instanceof Error ? e.message : "CV preview failed");
    } finally { setCvPreviewing(false); }
  }

  async function handleDownloadZip() {
    if (zipping) return;
    setActionError(null);
    setZipping(true);
    try {
      if (!row.tailored_cv_storage_path) throw new Error("Tailored CV is not available");
      if (!row.letter_id) throw new Error("No cover letter for this job");
      await downloadApplicationBundle({
        jobId: row.job_id, letterId: row.letter_id, cvStoragePath: row.tailored_cv_storage_path,
        companyName: row.job_company, hiringManager: row.job_hiring_manager,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to download ZIP bundle");
    } finally { setZipping(false); }
  }

  function handleArchive() {
    startTransition(async () => {
      try { await markJobDismissed(row.job_id, row.profile_id); }
      catch (e) { console.error(e); setActionError("Failed to archive"); return; }
      setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 400);
    });
  }

  function handleMoveBackToPool() {
    if (movingBack) return;
    setMovingBack(true);
    setActionError(null);
    startTransition(async () => {
      try {
        await markJobUnapplied(row.job_id, row.profile_id);
        setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 400);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to move back to pool");
        setMovingBack(false);
      }
    });
  }

  if (hidden) return null;

  return (
    <div className="bg-surface border border-border rounded-md p-4 anim-in">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <a href={row.job_url} target="_blank" rel="noopener noreferrer"
              className="text-[14px] font-semibold text-text hover:text-[var(--brand)] transition-colors">
              {row.job_title}
            </a>
            {isApplied && <Badge variant="green" className="text-[10px] px-1.5 h-4 font-bold">Applied</Badge>}
            {isArchived && <Badge variant="gray" className="text-[10px] px-1.5 h-4 font-bold">Archived</Badge>}
          </div>
          <p className="text-[12px] text-text-2 truncate mt-0.5">
            {row.job_company || "—"}{row.job_location && ` · ${row.job_location}`}{row.profile_name && ` · via ${row.profile_name}`}
          </p>
          <p className="text-[11px] text-text-3 mt-1 flex items-center gap-1.5">
            {isApplied
              ? <><CheckCircle2 className="w-3 h-3 text-emerald-600" /> {row.job_contact_email ? `Emailed ${row.job_contact_email}` : "Applied via job link"} · {relativeDate(row.job_applied_at)}</>
              : <><Archive className="w-3 h-3" /> Dismissed · {relativeDate(row.job_dismissed_at)}</>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[16px] font-bold tabular-nums ${scoreColor(row.tailored_match_score)}`}>
            {row.tailored_match_score == null ? "—" : Math.round(row.tailored_match_score)}
            {row.tailored_match_score != null && <span className="text-[10px] text-text-3 font-medium">/100</span>}
          </p>
        </div>
      </div>

      {actionError && <div className="mt-2"><ErrorBanner message={actionError} /></div>}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {row.letter_id && (
          <Button onClick={() => setShowEmail(true)} size="xs" icon={<Mail className="w-3 h-3" />}
            title="View the email message">
            Email message
          </Button>
        )}
        {row.letter_id && (
          <Button asChild variant="default" size="xs">
            <a href={`/api/applications/${row.letter_id}/cover-letter-pdf`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1">
              <FileType className="w-3 h-3" /> Cover letter
            </a>
          </Button>
        )}
        {row.tailored_cv_storage_path && (
          cvPdf.url
            ? <TailoredCvButton cvPdf={cvPdf} />
            : (
              <Button onClick={previewTailoredCv} disabled={cvPreviewing} isLoading={cvPreviewing}
                size="xs"
                icon={<FileText className="w-3 h-3" />}
                title="Open tailored CV PDF in new tab">
                Tailored CV
              </Button>
            )
        )}
        {row.tailored_cv_storage_path && row.letter_id && (
          <Button onClick={handleDownloadZip} disabled={zipping} isLoading={zipping}
            size="xs"
            icon={<Download className="w-3 h-3" />}>
            Download ZIP
          </Button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {isApplied && (
            <button onClick={handleMoveBackToPool} disabled={movingBack}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40"
              title="Didn't actually apply? Move it back to the pool">
              {movingBack ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronRight className="w-3 h-3 rotate-180" />}
              Move back to pool
            </button>
          )}
          {isApplied && (
            <button onClick={handleArchive}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors">
              <Archive className="w-3 h-3" /> Archive
            </button>
          )}
        </div>
      </div>

      {showEmail && row.letter_id && (
        <SentEmailModal letterId={row.letter_id} jobLabel={`${row.job_title}${row.job_company ? ` @ ${row.job_company}` : ""}`} onClose={() => setShowEmail(false)} />
      )}
    </div>
  );
}
