"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui";
import { Upload, CheckCircle2, FileText, FilePlus } from "lucide-react";
import { UploadProgressModal, DeleteConfirmModal } from "@/features/cv/library/LibraryModals";
import type { StructuredCv } from "@/lib/cv/backend";
import type { CategorisedSkills } from "@/lib/types";
import { type SkillLabels, DEFAULT_SKILL_LABELS } from "@/lib/cv/skillLabels";
import { CvRowCard } from "./LibraryCards";

export interface CvRow {
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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx" };



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

export function LibraryClient({ initial, skillLabels = DEFAULT_SKILL_LABELS }: Props) {
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

  // Arrive-at-card: the review page returns here as /cv#cv-<id>
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
      setUploadStep((s) => Math.min(s + 1, 2));
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
   * (ReviewClient create mode). No file, no AI — just an empty structured CV
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
        body:    JSON.stringify({ ext }) });
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
          body:    file });
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
          storage_path: storagePath }) });
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
        created_at:         new Date().toISOString() };
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
        body:    JSON.stringify({ is_active: true }) });
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
          <Button
            variant="default"
            size="md"
            onClick={handleCreate}
            disabled={creating || uploading}
          >
            <FilePlus className="h-4 w-4" />
            {creating ? "Creating…" : "Build from scratch"}
          </Button>
          <Button
            variant="brand"
            size="md"
            onClick={openFilePicker}
            disabled={uploading}
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload CV"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-light border border-red/20 px-4 py-3 text-sm text-red">
          {error}
        </div>
      )}

      {/* CV list — rounded-lg cards */}
      {cvs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-12 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-text-3" />
          <p className="text-text-3">No CV yet.</p>
          <p className="mt-1 text-sm text-text-3">
            Upload a PDF or DOCX, or build one from scratch to get started.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button
              variant="default"
              size="md"
              onClick={handleCreate}
              disabled={creating || uploading}
            >
              <FilePlus className="h-4 w-4" />
              {creating ? "Creating…" : "Build from scratch"}
            </Button>
            <Button
              variant="brand"
              size="md"
              onClick={openFilePicker}
              disabled={uploading}
            >
              <Upload className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload CV"}
            </Button>
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
              day: "numeric", month: "short", year: "numeric" });
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
                onEdit={() => router.push(`/cv/${cv.id}/review`)}
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
      {uploadPhase && typeof window !== "undefined" && (
        <UploadProgressModal
          phase={uploadPhase}
          step={uploadStep}
          onDismiss={dismissUploadModal}
          onProceed={proceedAfterUpload}
        />
      )}

      {/* Success flash — shown when the user closed the modal before the
          upload finished (background completion confirmation). */}
      {flash && typeof window !== "undefined" && createPortal(
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 rounded-full border border-[var(--border)] bg-surface px-4 py-2 text-body font-medium text-text shadow-lg">
          <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" /> {flash}
        </div>,
        document.body,
      )}

      {/* Delete confirm modal — same pattern as DeleteButton */}
      {typeof window !== "undefined" && (
        <DeleteConfirmModal
          target={deleteTarget}
          deleting={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

