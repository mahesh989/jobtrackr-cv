"use client";

/**
 * ApplicationCardV2 — the redesigned card used by the new 2-tab Applications
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
 *
 * Server actions wired to the same backend the legacy card used:
 *   PATCH /api/applications/[letter_id]                    — save cover letter
 *   POST  /api/applications/[letter_id]/review             — save email subject + body
 *   GET   /api/applications/[letter_id]/email-draft        — load saved subject + body
 *   POST  /api/applications/[letter_id]/send-email         — dispatch with attached CV
 *   markJobApplied / markJobDismissed                      — server actions
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown, ChevronRight, Mail, ExternalLink, FileText, FileType,
  Copy, Check, CheckCircle2, Archive, Loader2, Send, Save, Download,
  Sparkles, MoreHorizontal, AlertCircle,
} from "lucide-react";
import { markJobApplied, markJobDismissed, markJobUnapplied, markPoolDecision } from "@/lib/actions";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { renderTailoredCvBlob } from "@/lib/cvPdfRender";
import type { ContactDetails } from "@/lib/cvMarkdownHelpers";
import { downloadApplicationBundle } from "@/lib/downloadZip";
import { CvInlinePreview } from "./CvInlinePreview";
import { SentEmailModal } from "./SentEmailModal";

/**
 * Show a rendered blob: navigate the pre-opened tab when we have one, otherwise
 * (popups blocked → window.open returned null) fall back to a download, which is
 * never popup-blocked. Returns how it was presented so the caller can message.
 */
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

/**
 * Load the raw tailored-CV markdown + current contact details — the two inputs
 * renderTailoredCvBlob needs. Shared by the send-email flow, the inline-PDF
 * cache, and the no-letter preview fallback.
 */
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
  /** null for jobs applied outside the Applications flow (no cover letter). */
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
  /** Sort fields for the pool (post date / distance / recently analysed). */
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

function relativeDate(d: string | null) {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function scoreColor(n: number | null) {
  if (n == null) return "text-text-3";
  if (n >= 75) return "text-emerald-600";
  if (n >= 55) return "text-amber-600";
  return "text-red-600";
}

// ── Tailored CV inline PDF — client-render, cache, serve inline ───────────────
//
// The tailored CV's correct render is the client html2canvas pipeline
// (renderTailoredCvBlob). To make the "Tailored CV" button open inline in a new
// tab exactly like the Cover-letter button — a plain <a target="_blank">, no
// popup, no download fallback — we render those exact bytes once, PUT them to
// the server cache, then link to the GET route that streams them inline. The
// served PDF is byte-identical to the analysis-page Download.

type CvPdfState = "idle" | "preparing" | "ready" | "error";

function useTailoredCvPdf(row: ApplicationRowV2, onError?: (msg: string) => void) {
  const [state, setState] = useState<CvPdfState>("idle");
  const started = useRef(false);

  // Route keys off letter_id (same ownership gate as the cover-letter PDF).
  // Null for the rare applied-without-a-letter row — caller falls back then.
  const url = row.letter_id ? `/api/applications/${row.letter_id}/tailored-cv-pdf` : null;

  const ensure = useCallback(async () => {
    if (!url || !row.tailored_cv_storage_path) return;
    if (started.current) return;
    started.current = true;
    setState("preparing");
    try {
      // Fast path: already cached from a previous view / reload → skip the render.
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
      started.current = false; // allow a manual retry
      setState("error");
      onError?.(e instanceof Error ? e.message : "Could not prepare tailored CV PDF");
    }
  }, [url, row.tailored_cv_storage_path, onError]);

  return { state, url, ensure };
}

/** The pool/sent "Tailored CV" button, driven by useTailoredCvPdf. */
function TailoredCvButton({ cvPdf }: { cvPdf: ReturnType<typeof useTailoredCvPdf> }) {
  const { state, url, ensure } = cvPdf;
  if (!url) return null; // no letter_id — caller renders the fallback

  if (state === "ready") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
        title="Open tailored CV PDF in new tab"
      >
        <FileText className="w-3 h-3" /> Tailored CV
      </a>
    );
  }
  if (state === "error") {
    return (
      <button
        onClick={ensure}
        className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
        title="Preparing the CV PDF failed — click to retry"
      >
        <FileText className="w-3 h-3" /> Tailored CV
      </button>
    );
  }
  // idle | preparing — transitions to preparing immediately once ensure() runs
  return (
    <button
      disabled
      className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
      title="Preparing tailored CV PDF…"
    >
      <Loader2 className="w-3 h-3 animate-spin" /> Tailored CV
    </button>
  );
}

export function ApplicationCardV2({
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

// ── Pool card ────────────────────────────────────────────────────────────────

function PoolCard({ row, onActioned }: { row: ApplicationRowV2; onActioned?: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open,     setOpen]     = useState(false);
  const [section,  setSection]  = useState<"cv" | "cover" | "email">("cv");
  const [hidden,   setHidden]   = useState(false);
  const [menu,     setMenu]     = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Cover letter state — lazy-loaded on first expand
  const [coverLoaded,  setCoverLoaded]  = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverText,    setCoverText]    = useState("");
  const [coverSaved,   setCoverSaved]   = useState("");
  const [coverSaving,  setCoverSaving]  = useState(false);

  // Email state — lazy-loaded on first expand
  const [emailLoaded,  setEmailLoaded]  = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [subject,      setSubject]      = useState("");
  const [subjectSaved, setSubjectSaved] = useState("");
  const [body,         setBody]         = useState("");
  const [bodySaved,    setBodySaved]    = useState("");
  const [emailSaving,  setEmailSaving]  = useState(false);
  const [voiceRewritten, setVoiceRewritten] = useState(false);

  // Contact email override (editable inline)
  const [contactEmail, setContactEmail] = useState<string | null>(row.job_contact_email);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft,   setEmailDraft]   = useState(row.job_contact_email ?? "");

  // Send/apply state
  const [sending,  setSending]  = useState(false);
  const [copied,   setCopied]   = useState(false);
  const [zipping,  setZipping]  = useState(false);
  const [emailFallback, setEmailFallback] = useState<{ subject: string; body: string } | null>(null);

  const hasEmail   = !!contactEmail;
  const coverDirty = coverLoaded && coverText !== coverSaved;
  const emailDirty = emailLoaded && (subject !== subjectSaved || body !== bodySaved);

  // Lazy-load on first expand. State updates happen inside async callbacks
  // (not the synchronous effect body) to satisfy react-hooks/set-state-in-effect.
  const coverLoadStarted = useRef(false);
  const emailLoadStarted = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (!coverLoaded && !coverLoadStarted.current) {
      coverLoadStarted.current = true;
      (async () => {
        setCoverLoading(true);
        try {
          const res  = await fetch(`/api/applications/${row.letter_id}`);
          const json = await res.json();
          if (res.ok) {
            const text = json.pass_3_final ?? "";
            setCoverText(text);
            setCoverSaved(text);
            setCoverLoaded(true);
          } else {
            setActionError(json.error ?? "Could not load cover letter");
          }
        } catch (e) {
          setActionError(e instanceof Error ? e.message : "Network error");
        } finally {
          setCoverLoading(false);
        }
      })();
    }
    if (!emailLoaded && !emailLoadStarted.current) {
      emailLoadStarted.current = true;
      (async () => {
        setEmailLoading(true);
        try {
          const res  = await fetch(`/api/applications/${row.letter_id}/email-draft`);
          const json = await res.json();
          if (res.ok) {
            setSubject(json.subject ?? "");
            setSubjectSaved(json.subject ?? "");
            setBody(json.body ?? "");
            setBodySaved(json.body ?? "");
            setVoiceRewritten(!!json.voice_rewritten);
            setEmailLoaded(true);
          } else {
            setActionError(json.error ?? "Could not load email draft");
          }
        } catch (e) {
          setActionError(e instanceof Error ? e.message : "Network error");
        } finally {
          setEmailLoading(false);
        }
      })();
    }
  }, [open, row.letter_id, coverLoaded, emailLoaded]);

  async function saveCoverLetter() {
    if (coverSaving) return;
    setCoverSaving(true);
    setActionError(null);
    try {
      const res  = await fetch(`/api/applications/${row.letter_id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pass_3_final: coverText }),
      });
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? `Save failed (${res.status})`); return; }
      setCoverSaved(coverText);
      router.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Network error");
    } finally {
      setCoverSaving(false);
    }
  }

  async function saveEmail() {
    if (emailSaving) return;
    if (!subject.trim()) { setActionError("Subject can't be empty"); return; }
    if (!body.trim())    { setActionError("Body can't be empty"); return; }
    setEmailSaving(true);
    setActionError(null);
    try {
      const res  = await fetch(`/api/applications/${row.letter_id}/review`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject: subject.trim(), body }),
      });
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? `Save failed (${res.status})`); return; }
      setSubjectSaved(subject);
      setBodySaved(body);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Network error");
    } finally {
      setEmailSaving(false);
    }
  }

  function commitEmailAddress(value: string) {
    const trimmed = value.trim() || null;
    setContactEmail(trimmed);
    setEditingEmail(false);
    // Persist to jobs.contact_email in the DB so the send-email endpoint can
    // read it. markPoolDecision also stamps pool_decision_at but that column
    // is not used for tab-filtering in the new 2-tab design, so it's harmless.
    startTransition(async () => {
      try {
        await markPoolDecision(row.job_id, row.profile_id, trimmed ?? undefined);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to save email address");
      }
    });
  }

  // ── Send (email channel) ───────────────────────────────────────────────────
  async function handleSendEmail() {
    if (sending) return;
    if (emailDirty) { setActionError("Save your email changes before sending."); return; }
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

      const res  = await fetch(`/api/applications/${row.letter_id}/send-email`, {
        method: "POST",
        body:   form,
      });
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? "Send failed"); return; }

      // Slide out — the card belongs to the Sent tab now.
      setTimeout(() => { onActioned?.(); setHidden(true); router.refresh(); }, 600);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  }

  // ── Copy email (no-email channel) ──────────────────────────────────────────
  async function handleCopyEmail() {
    if (copied) return;
    setActionError(null);
    const payload = `Subject: ${subjectSaved}\n\n${bodySaved}`;
    const ok = await copyToClipboard(payload);
    if (!ok) { setEmailFallback({ subject: subjectSaved, body: bodySaved }); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Apply now (no-email channel) ───────────────────────────────────────────
  function handleApplyNow() {
    if (sending) return;
    // window.open MUST be from the user gesture or popup blockers eat it.
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

  // ── Archive ────────────────────────────────────────────────────────────────
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

  // ── Download ZIP ───────────────────────────────────────────────────────────
  async function handleDownloadZip() {
    if (zipping) return;
    setActionError(null);
    setZipping(true);
    try {
      if (!row.tailored_cv_storage_path) throw new Error("Tailored CV is not available");
      if (!row.letter_id) throw new Error("Cover letter is not available");
      await downloadApplicationBundle({
        jobId: row.job_id,
        letterId: row.letter_id,
        cvStoragePath: row.tailored_cv_storage_path,
        companyName: row.job_company,
        hiringManager: row.job_hiring_manager,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to download ZIP bundle");
    } finally {
      setZipping(false);
    }
  }

  // ── Tailored CV inline PDF (client-render → cache → serve inline) ──────────
  const cvPdf = useTailoredCvPdf(row, setActionError);
  const ensureCvPdf = cvPdf.ensure;
  // Prepare the PDF as soon as the card opens so the button is ready by the
  // time the user reaches for it. HEAD-checks first, renders only if uncached.
  useEffect(() => { if (open) ensureCvPdf(); }, [open, ensureCvPdf]);

  const analysisHref = row.latest_run_id
    ? `/dashboard/jobs/${row.job_id}/analyze/${row.latest_run_id}`
    : null;

  if (hidden) return null;

  return (
    <div className="bg-surface border border-border rounded-md anim-in hover:border-[var(--text-3)] transition-colors">
      {/* Collapsed summary — the toggle button plus a sibling link to the job
          posting (an <a> can't live inside the <button>). */}
      <div className="flex items-center gap-1 pr-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 flex items-center gap-3 pl-4 pr-1 py-3 text-left"
        >
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
        <a
          href={row.job_url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open job posting"
          aria-label="Open job posting"
          className="p-1.5 rounded-md text-text-3 hover:text-[var(--brand)] hover:bg-[var(--surface-2)] transition-colors shrink-0"
        >
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
                  {editingEmail ? (
                    <input
                      autoFocus type="email" value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      onBlur={() => commitEmailAddress(emailDraft)}
                      onKeyDown={(e) => { if (e.key === "Enter") commitEmailAddress(emailDraft); }}
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] w-56"
                    />
                  ) : (
                    <button
                      onClick={() => { setEmailDraft(contactEmail ?? ""); setEditingEmail(true); }}
                      className="font-mono text-[11px] hover:text-text underline decoration-dotted"
                    >
                      {contactEmail}
                    </button>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-text-3">
                  <ExternalLink className="w-3.5 h-3.5" />
                  No contact email — copy the message and apply via the job link
                  {!editingEmail && (
                    <button
                      onClick={() => { setEmailDraft(""); setEditingEmail(true); }}
                      className="text-[var(--brand)] hover:underline ml-1"
                    >
                      add email
                    </button>
                  )}
                </span>
              )}
              {!hasEmail && editingEmail && (
                <input
                  autoFocus type="email" placeholder="hr@company.com" value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onBlur={() => commitEmailAddress(emailDraft)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitEmailAddress(emailDraft); }}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] w-56"
                />
              )}
              {voiceRewritten && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-600 text-white">
                  <Sparkles className="w-3 h-3" /> Personalised in your voice
                </span>
              )}
              <span className="text-[11px] text-text-3 ml-auto">
                Cover letter generated {relativeDate(row.letter_completed_at) ?? "—"}
              </span>
            </div>
          </div>

          {/* Section toggle: CV → Cover letter → Email */}
          <div className="px-4 pt-2 pb-1 overflow-x-auto">
            <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded p-0.5 w-fit">
              {([
                ["cv",    "Tailored CV",    FileText],
                ["cover", "Cover letter",   FileType],
                ["email", "Email message",  Mail],
              ] as const).map(([k, label, Icon]) => (
                <button
                  key={k}
                  onClick={() => setSection(k)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all shrink-0 whitespace-nowrap ${
                    section === k ? "bg-[var(--surface)] text-text shadow-sm" : "text-text-2 hover:text-text"
                  }`}
                >
                  <Icon className="w-3 h-3" /> {label}
                  {k === "cover" && coverDirty && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
                  )}
                  {k === "email" && emailDirty && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Section body */}
          <div className="px-4 py-3">
            {section === "cv" && (
              <CvInlinePreview storagePath={row.tailored_cv_storage_path} />
            )}

            {section === "cover" && (
              <div className="space-y-2">
                {coverLoading ? (
                  <div className="py-8 flex items-center justify-center text-text-3 text-[12px]">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading cover letter…
                  </div>
                ) : (
                  <>
                    <textarea
                      value={coverText}
                      onChange={(e) => setCoverText(e.target.value)}
                      disabled={coverSaving}
                      rows={14}
                      className="w-full text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                      spellCheck
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-3">
                        {coverText.length} chars{coverDirty && " · unsaved changes"}
                      </span>
                      {coverDirty && (
                        <button
                          onClick={saveCoverLetter}
                          disabled={coverSaving}
                          className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 ml-auto disabled:opacity-40"
                        >
                          {coverSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                          {coverSaving ? "Saving…" : "Save changes"}
                        </button>
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
                {emailLoading ? (
                  <div className="py-8 flex items-center justify-center text-text-3 text-[12px]">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading email draft…
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">Subject</label>
                      <input
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        disabled={emailSaving}
                        maxLength={300}
                        className="w-full text-[13px] px-3 py-2 rounded border border-border bg-surface text-text focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">Message to the employer</label>
                      <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        disabled={emailSaving}
                        rows={7}
                        maxLength={20_000}
                        className="w-full text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                        spellCheck
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-3">
                        {emailDirty ? "Unsaved changes" : "Saved"}
                      </span>
                      {emailDirty && (
                        <button
                          onClick={saveEmail}
                          disabled={emailSaving}
                          className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 ml-auto disabled:opacity-40"
                        >
                          {emailSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                          {emailSaving ? "Saving…" : "Save changes"}
                        </button>
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

          {/* Action error */}
          {actionError && (
            <div className="mx-4 mb-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" />
              <p className="text-[12px] text-red-700 dark:text-red-400">{actionError}</p>
            </div>
          )}

          {/* Clipboard fallback */}
          {emailFallback && (
            <div className="mx-4 mb-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
              <p className="text-[11px] text-text-2 mb-2">Clipboard blocked — select all and copy manually:</p>
              <textarea
                readOnly
                rows={7}
                className="w-full text-[11px] font-mono text-text bg-surface border border-[var(--border)] rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                value={`Subject: ${emailFallback.subject}\n\n${emailFallback.body}`}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button onClick={() => setEmailFallback(null)} className="mt-1 text-[11px] text-text-3 hover:text-text">
                Dismiss
              </button>
            </div>
          )}

          {/* Action bar */}
          <div className="px-4 py-3 border-t border-border flex items-center gap-2 flex-wrap">
            {/* Document buttons */}
            <a
              href={`/api/applications/${row.letter_id}/cover-letter-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
              title="Open cover letter PDF in new tab"
            >
              <FileType className="w-3 h-3" /> Cover letter
            </a>
            {row.tailored_cv_storage_path && <TailoredCvButton cvPdf={cvPdf} />}
            {row.tailored_cv_storage_path && (
              <button
                onClick={handleDownloadZip}
                disabled={zipping}
                className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
                title="Download CV + cover letter as a ZIP"
              >
                {zipping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                Download ZIP
              </button>
            )}

            <div className="w-px h-5 bg-[var(--border)] mx-1" />

            {/* Send / Apply */}
            {hasEmail ? (
              <button
                onClick={handleSendEmail}
                disabled={sending || emailDirty}
                className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5 disabled:opacity-40"
                title={emailDirty ? "Save your email changes first" : "Send the email with the attached CV"}
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sending ? "Sending…" : "Send email"}
              </button>
            ) : (
              <>
                <button
                  onClick={handleCopyEmail}
                  disabled={!emailLoaded || emailDirty}
                  className="inline-flex items-center gap-1 gh-btn text-[12px] px-3 py-1.5 disabled:opacity-40"
                  title={emailDirty ? "Save your email changes first" : "Copy subject + body to clipboard"}
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied" : "Copy email"}
                </button>
                <button
                  onClick={handleApplyNow}
                  disabled={sending}
                  className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5 disabled:opacity-40"
                  title="Open the job posting and mark this as applied"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Apply now
                </button>
              </>
            )}

            {/* ··· menu */}
            <div className="relative ml-auto">
              <button
                onClick={() => setMenu((m) => !m)}
                className="inline-flex items-center gap-1 gh-btn text-[12px] px-2 py-1.5"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {menu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                  <div className="absolute right-0 bottom-full mb-1 w-48 bg-surface border border-border rounded-md shadow-lg py-1 z-20">
                    {analysisHref && (
                      <Link
                        href={analysisHref}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-[var(--surface-2)] hover:text-text"
                      >
                        <FileText className="w-3.5 h-3.5" /> Full analysis
                      </Link>
                    )}
                    <a
                      href={row.job_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-[var(--surface-2)] hover:text-text"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Open job posting
                    </a>
                    <div className="border-t border-border my-1" />
                    <button
                      onClick={() => { setMenu(false); handleArchive(); }}
                      disabled={sending}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-3 hover:bg-[var(--surface-2)] hover:text-text text-left disabled:opacity-40"
                    >
                      <Archive className="w-3.5 h-3.5" /> Archive
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sent / Applied card ─────────────────────────────────────────────────────

function SentCard({ row, onActioned }: { row: ApplicationRowV2; onActioned?: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [showEmail,    setShowEmail]    = useState(false);
  const [hidden,       setHidden]       = useState(false);
  const [zipping,      setZipping]      = useState(false);
  const [movingBack,   setMovingBack]   = useState(false);
  const [actionError,  setActionError]  = useState<string | null>(null);
  const [cvPreviewing, setCvPreviewing] = useState(false);

  const isApplied  = !!row.job_applied_at;
  const isArchived = !!row.job_dismissed_at && !isApplied;

  // Inline PDF via the server cache when a letter exists; the old client-render
  // preview below is the fallback for applied-without-a-letter rows (no route).
  const cvPdf = useTailoredCvPdf(row, setActionError);
  const ensureCvPdf = cvPdf.ensure;
  useEffect(() => { if (row.letter_id) ensureCvPdf(); }, [row.letter_id, ensureCvPdf]);

  async function previewTailoredCv() {
    if (cvPreviewing || !row.tailored_cv_storage_path) return;
    // Pre-open a tab from the click gesture for the best UX. If popups are
    // blocked window.open returns null — we DON'T bail here; presentBlob() below
    // falls back to a download (never popup-blocked) so the user still gets the CV.
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
      if (how === "download") {
        setActionError("Popups are blocked, so the CV was downloaded instead. Allow popups for this site to open it in a new tab.");
      }
    } catch (e) {
      try { win?.close(); } catch { /* ignore */ }
      setActionError(e instanceof Error ? e.message : "CV preview failed");
    } finally {
      setCvPreviewing(false);
    }
  }

  async function handleDownloadZip() {
    if (zipping) return;
    setActionError(null);
    setZipping(true);
    try {
      if (!row.tailored_cv_storage_path) throw new Error("Tailored CV is not available");
      if (!row.letter_id) throw new Error("No cover letter for this job");
      await downloadApplicationBundle({
        jobId: row.job_id,
        letterId: row.letter_id,
        cvStoragePath: row.tailored_cv_storage_path,
        companyName: row.job_company,
        hiringManager: row.job_hiring_manager,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to download ZIP bundle");
    } finally {
      setZipping(false);
    }
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
            <a
              href={row.job_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] font-semibold text-text hover:text-[var(--brand)] transition-colors"
            >
              {row.job_title}
            </a>
            {isApplied && (
              <span className="badge badge-green text-[10px] px-1.5 h-4 font-bold">Applied</span>
            )}
            {isArchived && (
              <span className="badge badge-gray text-[10px] px-1.5 h-4 font-bold">Archived</span>
            )}
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

      {actionError && (
        <div className="mt-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2">
          <p className="text-[12px] text-red-700 dark:text-red-400">{actionError}</p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {row.letter_id && (
          <button
            onClick={() => setShowEmail(true)}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
            title="View the email message"
          >
            <Mail className="w-3 h-3" /> Email message
          </button>
        )}
        {row.letter_id && (
          <a
            href={`/api/applications/${row.letter_id}/cover-letter-pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
          >
            <FileType className="w-3 h-3" /> Cover letter
          </a>
        )}
        {row.tailored_cv_storage_path && (
          cvPdf.url
            ? <TailoredCvButton cvPdf={cvPdf} />
            : (
              <button
                onClick={previewTailoredCv}
                disabled={cvPreviewing}
                className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
                title="Open tailored CV PDF in new tab"
              >
                {cvPreviewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                Tailored CV
              </button>
            )
        )}
        {row.tailored_cv_storage_path && row.letter_id && (
          <button
            onClick={handleDownloadZip}
            disabled={zipping}
            className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
          >
            {zipping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            Download ZIP
          </button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {isApplied && (
            <button
              onClick={handleMoveBackToPool}
              disabled={movingBack}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40"
              title="Didn't actually apply? Move it back to the pool"
            >
              {movingBack ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronRight className="w-3 h-3 rotate-180" />}
              Move back to pool
            </button>
          )}
          {isApplied && (
            <button
              onClick={handleArchive}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors"
            >
              <Archive className="w-3 h-3" /> Archive
            </button>
          )}
        </div>
      </div>

      {showEmail && row.letter_id && (
        <SentEmailModal
          letterId={row.letter_id}
          jobLabel={`${row.job_title}${row.job_company ? ` @ ${row.job_company}` : ""}`}
          onClose={() => setShowEmail(false)}
        />
      )}
    </div>
  );
}
