"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Upload, CheckCircle2, Trash2, FileText, ChevronRight, ChevronDown, Loader2, FilePlus, Pencil, X } from "lucide-react";
import { CvReviewClient } from "@/components/cv/CvReviewClient";
import type { StructuredCv } from "@/lib/cvBackend";
import { type SkillLabels, DEFAULT_SKILL_LABELS } from "@/lib/cv/skillLabels";

interface CategorisedSkills {
  technical?:        string[];
  soft_skills?:      string[];
  domain_knowledge?: string[];
}

interface CvRow {
  id:                    string;
  label:                 string;
  pdf_storage_path:      string;
  is_active:             boolean;
  categorised_skills?:   CategorisedSkills | null;
  created_at:            string;
  structured_cv_status?: string | null;
  /** Eager-loaded from the server so expand is instant. Null when the CV
   *  hasn't been structurized yet (uploads pre-rollout); InlineCvReview
   *  falls back to POST /structurize on demand. */
  structured_cv?:        StructuredCv | null;
}

interface Props {
  initial: CvRow[];
  /** Vertical-aware skill-bucket labels (from the user's role_families). */
  skillLabels?: SkillLabels;
}

// 5 MB — matches the bucket limit set in migration 013. We're no longer
// constrained by Vercel's 4.5 MB function body cap because the file goes
// straight from the browser to Supabase Storage.
const MAX_BYTES   = 5 * 1024 * 1024;
const ALLOWED_EXT = /\.(pdf|docx)$/i;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const EXT_FROM_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// Rotating status lines shown in the upload progress modal. The message
// advances on a timer while the real work runs in the background — the last
// line stays put until the upload actually finishes.
const UPLOAD_MESSAGES = [
  "Uploading your CV…",
  "Analysing the sections…",
  "Almost there — tidying things up…",
];

// Extract a useful error string from a fetch response, even when the body
// isn't JSON (e.g. Vercel's edge-level rejection for over-limit bodies).
async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: string };
    if (j.error) return j.error;
  } catch { /* not JSON */ }
  if (res.status === 413) return "File too large for the server.";
  return text.slice(0, 200) || `Upload failed (HTTP ${res.status})`;
}

export function CvLibraryClient({ initial, skillLabels = DEFAULT_SKILL_LABELS }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cvs, setCvs]             = useState<CvRow[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating]   = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<CvRow | null>(null);
  const [deleting, setDeleting]         = useState(false);

  // Arrive-at-card: the review page returns here as /dashboard/cv#cv-<id>
  // after a save. Scroll that CV into view and pulse a highlight so the user
  // lands on the CV they just edited, not the top of the list.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    const m = (typeof window !== "undefined" ? window.location.hash : "").match(/^#cv-(.+)$/);
    if (!m) return;
    const id = m[1];
    const el = document.getElementById(`cv-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const on  = setTimeout(() => setHighlightId(id), 0);
    const off = setTimeout(() => setHighlightId(null), 2200);
    return () => { clearTimeout(on); clearTimeout(off); };
  }, []);

  // ── Upload progress modal ────────────────────────────────────────────────
  // `uploadPhase` drives the modal: "uploading" (spinner + rotating messages)
  // → "success" (check + OK). null = modal closed. Closing the modal never
  // cancels the in-flight upload; it only hides the box.
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "success" | null>(null);
  const [uploadStep,  setUploadStep]  = useState(0);
  const [flash,       setFlash]       = useState<string | null>(null);
  const dismissedRef = useRef(false);            // user closed the box mid-upload
  const redirectRef  = useRef<string | null>(null); // where "OK" / auto-proceed goes

  // Advance the status message on a timer while uploading (stops at the last).
  useEffect(() => {
    if (uploadPhase !== "uploading") return;
    const id = window.setInterval(() => {
      setUploadStep((s) => Math.min(s + 1, UPLOAD_MESSAGES.length - 1));
    }, 2600);
    return () => window.clearInterval(id);
  }, [uploadPhase]);

  // On success, auto-proceed after a short "flash" unless the user acts first.
  useEffect(() => {
    if (uploadPhase !== "success") return;
    const id = window.setTimeout(() => {
      const to = redirectRef.current;
      setUploadPhase(null);
      if (to) router.push(to);
    }, 3800);
    return () => window.clearTimeout(id);
  }, [uploadPhase, router]);

  function openUploadModal() {
    dismissedRef.current = false;
    setUploadStep(0);
    setUploadPhase("uploading");
  }
  // Close (X) — hides the box only. Marks dismissed so a later success won't
  // pull the user into the review form; the background upload keeps running.
  function dismissUploadModal() {
    dismissedRef.current = true;
    setUploadPhase(null);
  }
  // OK — proceed now to wherever the finished upload wants to go.
  function proceedAfterUpload() {
    const to = redirectRef.current;
    setUploadPhase(null);
    if (to) router.push(to);
  }

  // Inline review-expand state — only one CV expanded at a time so the
  // page stays focused; clicking the same CV again collapses it.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Active CV always first; the rest keep their existing (newest-first) order.
  const orderedCvs = useMemo(() => {
    const list = [...cvs];
    list.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return 0;
    });
    return list;
  }, [cvs]);

  /**
   * Trigger the hidden file input from the visible "Upload CV" button.
   * Matches cv-magic's UX — one button, no separate form section.
   */
  function openFilePicker() {
    fileInputRef.current?.click();
  }

  /**
   * Create a blank "built in app" CV and jump straight into the builder
   * (CvReviewClient create mode). No file, no AI — just an empty structured CV
   * the user fills in by hand.
   */
  async function handleCreate() {
    if (creating) return;
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/cv/create", { method: "POST" });
      if (!res.ok) { setError(await readError(res)); return; }
      const json = await res.json() as { id: string; redirect_to: string };
      router.push(json.redirect_to);
    } catch (err) {
      setError(err instanceof Error ? `Network error: ${err.message}` : "Could not create CV.");
    } finally {
      setCreating(false);
    }
  }

  /**
   * Auto-derive the label from the filename and run the upload.
   * Strips the extension and underscores → spaces, then title-cases the
   * first letter so the row label looks tidy.
   *   "Maheshwor_Tiwari.pdf" → "Maheshwor Tiwari"
   */
  function labelFromFilename(name: string): string {
    const noExt = name.replace(/\.(pdf|docx)$/i, "");
    const human = noExt.replace(/[_\-]+/g, " ").trim();
    if (!human) return "Untitled CV";
    return human.charAt(0).toUpperCase() + human.slice(1);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Always clear the input so the same file can be re-selected if upload fails.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    setError(null);

    if (!ALLOWED_EXT.test(file.name) && !ALLOWED_MIME.has(file.type)) {
      setError(`Unsupported file. Pick a .pdf or .docx (got "${file.name}").`);
      return;
    }
    if (file.size > MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      setError(`This file is ${mb} MB — the limit is 5 MB. Try compressing it or splitting sections.`);
      return;
    }

    const label = labelFromFilename(file.name);
    setUploading(true);
    openUploadModal();

    const ext = EXT_FROM_MIME[file.type] ?? (file.name.toLowerCase().endsWith(".docx") ? "docx" : "pdf");
    const contentType = ext === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";

    // ── Step 1 — ask the server for a one-time signed upload URL.
    let cvId       = "";
    let storagePath = "";
    let signedUrl   = "";
    let token       = "";
    try {
      const r = await fetch("/api/cv/upload-url", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ext }),
      });
      if (!r.ok) {
        setUploading(false);
        setUploadPhase(null);
        setError(await readError(r));
        return;
      }
      const j = await r.json();
      cvId        = j.cv_id;
      storagePath = j.storage_path;
      signedUrl   = j.signed_url;
      token       = j.token;
    } catch (err) {
      setUploading(false);
      setUploadPhase(null);
      setError(err instanceof Error ? `Network error: ${err.message}` : "Could not get upload URL.");
      return;
    }

    // ── Step 2 — upload bytes directly to the signed URL.
    // Use the supabase-js uploadToSignedUrl helper so SDK handles edge cases.
    const supabase = createClient();
    const { error: uploadErr } = await supabase.storage
      .from("cvs")
      .uploadToSignedUrl(storagePath, token, file, { contentType, upsert: false });

    if (uploadErr) {
      // If the SDK path failed with "Failed to fetch", try a raw fetch PUT as a fallback.
      // This bypasses any SDK-level header/auth logic and uses the simplest possible request.
      try {
        const r = await fetch(signedUrl, {
          method:  "PUT",
          headers: { "Content-Type": contentType },
          body:    file,
        });
        if (!r.ok) {
          setUploading(false);
          setUploadPhase(null);
          setError(`Storage upload failed (HTTP ${r.status}). ${await r.text().catch(() => "")}`.slice(0, 300));
          return;
        }
      } catch (err) {
        setUploading(false);
        setUploadPhase(null);
        setError(
          `Upload failed: ${uploadErr.message}` +
          (err instanceof Error ? ` — fallback also failed: ${err.message}` : ""),
        );
        return;
      }
      // fallback PUT succeeded — fall through to finalise (upload still in progress)
    }

    // ── Step 3 — tell the API to finalise (extract text + INSERT row).
    try {
      const res = await fetch("/api/cv", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          cv_id:        cvId,
          label,
          storage_path: storagePath,
        }),
      });
      if (!res.ok) {
        // Best-effort cleanup of the orphan Storage object.
        await supabase.storage.from("cvs").remove([storagePath]);
        setUploadPhase(null);
        setError(await readError(res));
        return;
      }
      const json = await res.json();
      const newRow: CvRow = {
        id:                 json.id,
        label:              json.label,
        pdf_storage_path:   json.pdf_storage_path,
        is_active:          json.is_active,
        categorised_skills: json.categorised_skills ?? null,
        created_at:         new Date().toISOString(),
      };
      setCvs((prev) => {
        const demoted = newRow.is_active
          ? prev.map((c) => ({ ...c, is_active: false }))
          : prev;
        return [newRow, ...demoted];
      });
      // Forced review step — every freshly-structurized CV must pass through
      // the review form before it can drive analysis. The route only returns
      // `redirect_to` when structurization succeeded; when it didn't, we stay
      // on the library (legacy fallback path). Rather than yank the user away
      // instantly, surface a success state in the progress modal.
      redirectRef.current =
        typeof json.redirect_to === "string" && json.redirect_to.length > 0
          ? json.redirect_to
          : null;
      if (dismissedRef.current) {
        // User closed the progress box mid-upload — don't pull them into the
        // review form. Confirm with a brief flash; the row is already listed.
        setFlash("CV uploaded successfully");
        window.setTimeout(() => setFlash(null), 3500);
      } else {
        setUploadPhase("success");
      }
    } catch (err) {
      await supabase.storage.from("cvs").remove([storagePath]);
      setUploadPhase(null);
      setError(
        err instanceof Error
          ? `Network error: ${err.message}`
          : "Network error — try again.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleSetActive(id: string) {
    setError(null);
    setPendingId(id);
    try {
      const res = await fetch(`/api/cv/${id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ is_active: true }),
      });
      if (!res.ok) { setError(await readError(res)); return; }
      // Move newly active CV to the top of the list
      setCvs((prev) => {
        const updated = prev.map((c) => ({ ...c, is_active: c.id === id }));
        const active  = updated.find((c) => c.id === id)!;
        return [active, ...updated.filter((c) => c.id !== id)];
      });
      router.refresh();
    } catch {
      setError("Network error setting active CV.");
    } finally {
      setPendingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/cv/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) { setError(await readError(res)); return; }
      setCvs((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      setDeleteTarget(null);
      router.refresh();
    } catch {
      setError("Network error deleting CV.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header row — title left, Upload CV button right (matches cv-magic) */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-text-3">
            PDF or DOCX. Max 5 MB. The first CV you upload becomes active automatically.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={handleCreate}
            disabled={creating || uploading}
            className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-2 text-sm font-medium text-text transition-colors hover:border-[var(--brand)]/50 hover:text-[var(--brand)] hover:bg-[var(--brand)]/5 disabled:opacity-50"
          >
            <FilePlus className="h-4 w-4" />
            {creating ? "Creating…" : "Build from scratch"}
          </button>
          <button
            onClick={openFilePicker}
            disabled={uploading}
            className="flex items-center gap-2 rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-shadow hover:opacity-90 hover:glow-gold disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload CV"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-light border border-red/20 px-4 py-3 text-sm text-red">
          {error}
        </div>
      )}

      {/* CV list — rounded-lg cards with glass effect, matches cv-magic */}
      {cvs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-12 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-text-3" />
          <p className="text-text-3">No CV yet.</p>
          <p className="mt-1 text-sm text-text-3">
            Upload a PDF or DOCX, or build one from scratch to get started.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || uploading}
              className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-2 text-sm font-medium text-text transition-colors hover:border-[var(--brand)]/50 hover:text-[var(--brand)] hover:bg-[var(--brand)]/5 disabled:opacity-50"
            >
              <FilePlus className="h-4 w-4" />
              {creating ? "Creating…" : "Build from scratch"}
            </button>
            <button
              onClick={openFilePicker}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-shadow hover:opacity-90 hover:glow-gold disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload CV"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {orderedCvs.map((cv) => {
            const isBuilt = cv.pdf_storage_path?.startsWith("built://") ?? false;
            const isDraft = isBuilt && cv.structured_cv_status !== "verified";
            const ext = isBuilt
              ? (isDraft ? "Draft" : "Built")
              : (cv.pdf_storage_path?.endsWith(".docx") ? "DOCX" : "PDF");
            const created = new Date(cv.created_at).toLocaleDateString("en-AU", {
              day: "numeric", month: "short", year: "numeric",
            });
            return (
              <div
                key={cv.id}
                id={`cv-${cv.id}`}
                className={`scroll-mt-24 rounded-2xl transition-all duration-500 ${
                  highlightId === cv.id ? "ring-2 ring-[var(--brand)]/70 ring-offset-2 ring-offset-transparent" : ""
                }`}
              >
              <CvRowCard
                cv={cv}
                ext={ext}
                isBuilt={isBuilt}
                isDraft={isDraft}
                created={created}
                skillLabels={skillLabels}
                pending={pendingId === cv.id}
                expanded={expandedId === cv.id}
                onToggleExpand={() => setExpandedId(prev => prev === cv.id ? null : cv.id)}
                onEdit={() => router.push(`/dashboard/cv/${cv.id}/review`)}
                onActivate={() => handleSetActive(cv.id)}
                onDelete={() => setDeleteTarget(cv)}
                onStatusChange={(newStatus) =>
                  setCvs((prev) => prev.map((c) => c.id === cv.id ? { ...c, structured_cv_status: newStatus } : c))
                }
                onStructuredUpdated={(structured) =>
                  setCvs((prev) => prev.map((c) => c.id === cv.id ? { ...c, structured_cv: structured } : c))
                }
                onSkillsUpdated={(skills) =>
                  setCvs((prev) => prev.map((c) => c.id === cv.id ? { ...c, categorised_skills: skills } : c))
                }
              />
              </div>
            );
          })}
        </div>
      )}

      {/* Upload progress modal — spinner + rotating status, then success + OK.
          The X only closes the box; the upload keeps running in the background. */}
      {uploadPhase && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl"
          >
            <button
              type="button"
              onClick={dismissUploadModal}
              aria-label="Close"
              className="absolute right-3 top-3 rounded-full p-1.5 text-text-3 hover:text-text hover:bg-[var(--surface-2)]/60 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex flex-col items-center text-center pt-3">
              {uploadPhase === "uploading" ? (
                <>
                  <Loader2 className="h-11 w-11 animate-spin text-[var(--brand)]" aria-hidden="true" />
                  <p className="mt-4 text-[15px] font-semibold text-text" aria-live="polite">
                    {UPLOAD_MESSAGES[uploadStep]}
                  </p>
                  <p className="mt-1 text-[13px] text-text-2">
                    This may take a moment — please wait.
                  </p>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-11 w-11 text-green-500" aria-hidden="true" />
                  <p className="mt-4 text-[15px] font-semibold text-text">CV uploaded successfully</p>
                  <p className="mt-1 text-[13px] text-text-2">Taking you to review your CV…</p>
                  <button
                    type="button"
                    onClick={proceedAfterUpload}
                    className="mt-5 rounded-full bg-[var(--brand)] px-7 py-2 text-[13px] font-medium text-[var(--brand-fg)] hover:opacity-90 transition-opacity"
                  >
                    OK
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Success flash — shown when the user closed the modal before the
          upload finished (background completion confirmation). */}
      {flash && typeof window !== "undefined" && createPortal(
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 rounded-full border border-[var(--border)] bg-surface px-4 py-2 text-[13px] font-medium text-text shadow-lg">
          <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" /> {flash}
        </div>,
        document.body,
      )}

      {/* Delete confirm modal — same pattern as DeleteProfileButton */}
      {deleteTarget && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-text/40 backdrop-blur-sm"
            onClick={() => !deleting && setDeleteTarget(null)}
          />
          <div className="relative bg-surface rounded-lg border border-[var(--border)] shadow-xl max-w-md w-full p-6">
            <h2 className="text-[16px] font-semibold text-text mb-2">Delete this CV?</h2>
            <p className="text-[13px] text-text-2 leading-relaxed mb-2">
              This removes <strong className="text-text">{deleteTarget.label}</strong>{" "}
              from your library and deletes the file from storage.
              {deleteTarget.is_active && (
                <> It is currently your <strong>active</strong> CV — after deletion you will need to set another active before running an analysis.</>
              )}
            </p>
            <p className="text-[12px] text-[#CF222E] font-medium mb-5">This action cannot be undone.</p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="gh-btn text-[13px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="gh-btn gh-btn-danger text-[13px]"
              >
                {deleting ? "Deleting…" : "Yes, delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── CV row card — cv-magic style ──────────────────────────────────────────

function CvRowCard({
  cv,
  ext,
  isBuilt,
  isDraft,
  created,
  skillLabels,
  pending,
  expanded,
  onToggleExpand,
  onEdit,
  onActivate,
  onDelete,
  onStatusChange,
  onStructuredUpdated,
  onSkillsUpdated,
}: {
  cv:                  CvRow;
  ext:                 string;
  isBuilt:             boolean;
  isDraft:             boolean;
  created:             string;
  skillLabels:         SkillLabels;
  pending:             boolean;
  expanded:            boolean;
  onToggleExpand:      () => void;
  onEdit:              () => void;
  onActivate:          () => void;
  onDelete:            () => void;
  onStatusChange:      (status: string) => void;
  onStructuredUpdated: (structured: StructuredCv) => void;
  onSkillsUpdated:     (skills: CategorisedSkills) => void;
}) {
  // A still-unfinished built CV opens the full-page builder rather than the
  // inline review (create mode lives on the review route).
  const primaryAction = isDraft ? onEdit : onToggleExpand;

  // When collapsed, the WHOLE card is the click target — header, meta, and
  // skills block trigger the primary action. Once expanded, the click is removed
  // so nested form interactions don't accidentally collapse the card.
  const collapsedProps = expanded ? {} : {
    role:      "button" as const,
    tabIndex:  0,
    "aria-expanded": false,
    onClick:   primaryAction,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        primaryAction();
      }
    },
  };

  return (
    <div
      {...collapsedProps}
      className={
        "group rounded-xl bg-[var(--surface)] transition-all overflow-hidden " +
        (expanded ? "" : "cursor-pointer hover:bg-[var(--surface-2)]/30 hover:shadow-md ") +
        (cv.is_active
          ? "border-2 border-[var(--brand)]/50 shadow-sm"
          : "border border-[var(--border)] hover:border-[var(--brand)]/40")
      }
    >
      {/* HEADER — non-interactive; the wrapper handles click when collapsed,
          and the Collapse button handles it when expanded. Action buttons
          (InlineAction) stopPropagation in either state. */}
      <div
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-text truncate">{cv.label}</span>
            <span className="text-[11px] text-text-3 px-1.5 py-0.5 rounded-full bg-[var(--surface-2)]/60">{ext}</span>
            {cv.is_active && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/30 bg-[var(--brand)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--brand)]">
                <CheckCircle2 className="h-3 w-3" />
                Active
              </span>
            )}
            {cv.structured_cv_status === "verified" && (
              <span className="rounded-full border border-green-700/40 bg-green-700/10 px-2 py-0.5 text-[11px] font-semibold text-green-800 dark:text-green-300">
                Reviewed
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] text-text-3" suppressHydrationWarning>
            <span>{isBuilt ? "Created" : "Uploaded"} {created}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Inline actions — span-as-button so the outer button doesn't nest;
              roles + onKeyDown give native click semantics. */}
          {!cv.is_active && (
            <InlineAction
              label="Set active"
              disabled={pending}
              onClick={onActivate}
            />
          )}
          {isDraft ? (
            <InlineAction
              label="Continue editing"
              icon={<Pencil className="h-3.5 w-3.5" />}
              primary
              disabled={pending}
              onClick={onEdit}
            />
          ) : (
            <InlineAction
              label={expanded ? "Collapse" : "Expand"}
              icon={expanded
                ? <ChevronDown className="h-3.5 w-3.5" />
                : <ChevronRight className="h-3.5 w-3.5" />}
              primary
              disabled={pending}
              onClick={onToggleExpand}
            />
          )}
          <InlineAction
            label="Delete CV"
            iconOnly
            icon={<Trash2 className="h-4 w-4" />}
            danger
            disabled={pending}
            onClick={onDelete}
          />
        </div>
      </div>

      {/* COLLAPSED BODY — skills block (kept lightweight) */}
      {!expanded && (
        <div className="px-4 pb-4">
          <CvSkillsBlock skills={cv.categorised_skills} cvId={cv.id} onSkillsUpdated={onSkillsUpdated} />
        </div>
      )}

      {/* EXPANDED BODY — review form. Uses eager-loaded structured_cv for
          instant open; falls back to a lazy fetch when missing (only happens
          for CVs uploaded before the structurize column existed). */}
      {expanded && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/20 px-4 py-5 sm:px-6">
          <InlineCvReview
            cvId={cv.id}
            initialLabel={cv.label}
            initialStatus={cv.structured_cv_status}
            initialStructuredCv={cv.structured_cv ?? null}
            skillLabels={skillLabels}
            onStatusChange={onStatusChange}
            onStructuredLoaded={onStructuredUpdated}
          />
        </div>
      )}
    </div>
  );
}

/**
 * InlineAction — span styled as a button, stops propagation so it doesn't
 * trigger the row's expand toggle. Tab/Enter/Space activate it.
 */
function InlineAction({
  label, icon, primary, danger, iconOnly, disabled, onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const base = "inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md transition-colors select-none cursor-pointer";
  const tone = danger
    ? "p-1.5 text-text-3 hover:bg-red-light hover:text-red"
    : primary
    ? "px-3 py-1.5 border border-[var(--brand)]/40 bg-[var(--brand)]/10 text-[var(--brand)] hover:bg-[var(--brand)]/15"
    : "px-3 py-1.5 border border-[var(--border)] bg-[var(--surface-2)]/40 text-text hover:bg-[var(--brand)]/5 hover:text-[var(--brand)] hover:border-[var(--brand)]/40";
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={iconOnly ? label : undefined}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      className={`${base} ${tone} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {icon}
      {!iconOnly && label}
    </span>
  );
}

/**
 * InlineCvReview — renders the review form using the eager-loaded
 * structured_cv when available (instant open). When the CV hasn't been
 * structurized yet, runs POST /structurize + GET /structured first.
 */
function InlineCvReview({
  cvId, initialLabel, initialStatus, initialStructuredCv, skillLabels,
  onStatusChange, onStructuredLoaded,
}: {
  cvId:                 string;
  initialLabel:         string;
  initialStatus:        string | null | undefined;
  initialStructuredCv:  StructuredCv | null;
  skillLabels:          SkillLabels;
  onStatusChange:       (status: string) => void;
  onStructuredLoaded:   (structured: StructuredCv) => void;
}) {
  // Fast path: structured_cv is already on the page — render immediately.
  const hasEager = !!initialStructuredCv;
  const [loading, setLoading] = useState(!hasEager);
  const [error, setError]     = useState<string | null>(null);
  const [data, setData]       = useState<{ structured_cv: StructuredCv; status: string } | null>(
    hasEager ? { structured_cv: initialStructuredCv!, status: initialStatus ?? "parsed" } : null,
  );

  // Only run on mount when there's no eager data. Once fetched, the parent
  // memoises it so re-expanding the same row stays instant.
  useEffect(() => {
    if (hasEager) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (!initialStatus) {
          const r = await fetch(`/api/cv/${cvId}/structurize`, { method: "POST" });
          if (!r.ok) {
            const j = await r.json().catch(() => ({})) as { error?: string };
            if (!cancelled) setError(j.error ?? `Could not prepare review (${r.status})`);
            return;
          }
        }
        const r = await fetch(`/api/cv/${cvId}/structured`);
        if (!r.ok) {
          if (!cancelled) setError(`Could not load review (${r.status})`);
          return;
        }
        const j = await r.json() as {
          label: string;
          structured_cv: StructuredCv;
          structured_cv_status: string;
        };
        if (!cancelled) {
          setData({ structured_cv: j.structured_cv, status: j.structured_cv_status });
          onStatusChange(j.structured_cv_status);
          onStructuredLoaded(j.structured_cv);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvId, hasEager]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-3 text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Preparing review…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-md border border-red/20 bg-red-light/40 px-3 py-2 text-sm text-red">
        {error ?? "Could not load review."}
      </div>
    );
  }
  return (
    <CvReviewClient
      cvId={cvId}
      label={initialLabel}
      initialStructuredCv={data.structured_cv}
      initialStatus={data.status}
      skillLabels={skillLabels}
    />
  );
}

// ── Categorised CV skills — collapsed by default ───────────────────────────

function CvSkillsBlock({ skills, cvId, onSkillsUpdated }: {
  skills?: CategorisedSkills | null;
  cvId: string;
  onSkillsUpdated: (skills: CategorisedSkills) => void;
}) {
  const [open, setOpen]           = useState(false);
  const [reCatLoading, setReCatLoading] = useState(false);
  const [reCatError, setReCatError]     = useState<string | null>(null);

  async function handleRecategorise() {
    setReCatLoading(true);
    setReCatError(null);
    try {
      const res = await fetch(`/api/cv/${cvId}/recategorise`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setReCatError(j.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      const { categorised_skills } = await res.json() as { categorised_skills: CategorisedSkills };
      onSkillsUpdated(categorised_skills);
    } catch (err) {
      setReCatError(err instanceof Error ? err.message : "Network error");
    } finally {
      setReCatLoading(false);
    }
  }

  if (!skills) {
    return (
      <div className="mt-2" onClick={e => e.stopPropagation()}>
        <p className="text-[11px] text-text-3 italic mb-1.5">
          Skills not yet categorised. Make sure an AI key is connected, then click below.
        </p>
        {reCatError && <p className="text-[11px] text-red mb-1">{reCatError}</p>}
        <button
          onClick={(e) => { e.stopPropagation(); handleRecategorise(); }}
          disabled={reCatLoading}
          className="text-[11px] font-medium text-[var(--brand)] hover:underline disabled:opacity-50"
        >
          {reCatLoading ? "Categorising…" : "↺ Categorise skills now"}
        </button>
      </div>
    );
  }

  const tech   = skills.technical ?? [];
  const soft   = skills.soft_skills ?? [];
  const domain = skills.domain_knowledge ?? [];
  const total  = tech.length + soft.length + domain.length;
  if (total === 0) return null;

  return (
    <div className="mt-2" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="text-xs text-text-2 hover:text-[var(--brand)] inline-flex items-center gap-1 transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
        Show AI-extracted skills ({total})
      </button>

      {open && (
        <div className="mt-2 space-y-2 bg-surface-2/40 border border-border rounded p-3">
          <SkillRow label="Technical"       items={tech}   variant="primary" />
          <SkillRow label="Soft skills"     items={soft}   variant="muted" />
          <SkillRow label="Domain knowledge" items={domain} variant="muted" />
        </div>
      )}
    </div>
  );
}

function SkillRow({
  label, items, variant,
}: {
  label: string;
  items: string[];
  variant: "primary" | "muted";
}) {
  if (items.length === 0) return null;
  const chipCls = variant === "primary"
    ? "bg-[#DDF4FF] text-[var(--brand)] border-[var(--brand)]/20"
    : "bg-surface text-text-2 border-border";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="w-fit text-[10px] font-semibold uppercase tracking-widest text-text-3 bg-surface border border-border rounded px-1.5 py-0.5">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((s) => (
          <span key={s} className={`text-[11px] px-1.5 py-0.5 rounded border ${chipCls}`}>{s}</span>
        ))}
      </div>
    </div>
  );
}
