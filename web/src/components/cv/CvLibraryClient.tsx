"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface CvRow {
  id:                string;
  label:             string;
  pdf_storage_path:  string;
  is_active:         boolean;
  created_at:        string;
}

interface Props {
  initial: CvRow[];
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

export function CvLibraryClient({ initial }: Props) {
  const router = useRouter();
  const [cvs, setCvs]             = useState<CvRow[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<CvRow | null>(null);
  const [deleting, setDeleting]         = useState(false);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const form = e.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Pick a PDF or DOCX file first.");
      return;
    }
    if (!ALLOWED_EXT.test(file.name) && !ALLOWED_MIME.has(file.type)) {
      setError(`Unsupported file. Pick a .pdf or .docx (got "${file.name}").`);
      return;
    }
    if (file.size > MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      setError(`This file is ${mb} MB — the limit is 5 MB. Try compressing it or splitting sections.`);
      return;
    }
    const label = (data.get("label") ?? "").toString().trim();
    if (!label) {
      setError("Give the CV a label (e.g. 'Master CV 2026').");
      return;
    }

    setUploading(true);

    // ── Step 1 — direct browser upload to Supabase Storage.
    // RLS allows this because the path's first segment is the user's auth.uid().
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setUploading(false);
      setError("Your session has expired — refresh and sign in again.");
      return;
    }

    const ext = EXT_FROM_MIME[file.type] ?? (file.name.toLowerCase().endsWith(".docx") ? "docx" : "pdf");
    const cvId = crypto.randomUUID();
    const storagePath = `${user.id}/${cvId}.${ext}`;

    const contentType = ext === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";

    const { error: uploadErr } = await supabase.storage
      .from("cvs")
      .upload(storagePath, file, {
        contentType,
        upsert: false,
      });

    if (uploadErr) {
      setUploading(false);
      setError(`Upload failed: ${uploadErr.message}`);
      return;
    }

    // ── Step 2 — tell the API to finalise (extract text + INSERT row).
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
        setError(await readError(res));
        return;
      }
      const json = await res.json();
      const newRow: CvRow = {
        id:               json.id,
        label:            json.label,
        pdf_storage_path: json.pdf_storage_path,
        is_active:        json.is_active,
        created_at:       new Date().toISOString(),
      };
      setCvs((prev) => {
        const demoted = newRow.is_active
          ? prev.map((c) => ({ ...c, is_active: false }))
          : prev;
        return [newRow, ...demoted];
      });
      form.reset();
    } catch (err) {
      await supabase.storage.from("cvs").remove([storagePath]);
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
      setCvs((prev) => prev.map((c) => ({ ...c, is_active: c.id === id })));
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
    <div className="max-w-3xl space-y-6">
      {/* Upload form */}
      <div className="bg-surface border border-border rounded-md">
        <div className="px-5 py-4 border-b border-border bg-surface-2">
          <h2 className="text-[14px] font-semibold text-text">Upload a CV</h2>
          <p className="text-[12px] text-text-3 mt-0.5">
            PDF or DOCX. Max 5 MB. The first CV you upload becomes active automatically.
          </p>
        </div>
        <form onSubmit={handleUpload} className="px-5 py-5 space-y-4">
          <div>
            <label className="block text-[12px] text-text-2 mb-1.5" htmlFor="cv-label">
              Label
            </label>
            <input
              id="cv-label"
              name="label"
              type="text"
              placeholder="Master CV 2026"
              required
              className="w-full bg-surface border border-border rounded-md px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <label className="block text-[12px] text-text-2 mb-1.5" htmlFor="cv-file">
              File
            </label>
            <input
              id="cv-file"
              name="file"
              type="file"
              accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx"
              required
              className="block w-full text-[13px] text-text file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:text-[12px] file:text-text-2 hover:file:bg-surface"
            />
          </div>
          {error && (
            <div className="rounded-md bg-red-light border border-red/20 px-3 py-2 text-[12px] text-red">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={uploading}
            className="gh-btn gh-btn-primary text-[13px]"
          >
            {uploading ? "Uploading…" : "Upload CV"}
          </button>
        </form>
      </div>

      {/* List */}
      <div className="bg-surface border border-border rounded-md overflow-hidden">
        <div className="px-5 py-4 border-b border-border bg-surface-2">
          <h2 className="text-[14px] font-semibold text-text">Your CVs</h2>
          <p className="text-[12px] text-text-3 mt-0.5">
            {cvs.length === 0
              ? "No CVs yet — upload one to enable analysis."
              : `${cvs.length} ${cvs.length === 1 ? "CV" : "CVs"} stored. Pick one as active.`}
          </p>
        </div>

        {cvs.length > 0 && (
          <ul className="divide-y divide-border">
            {cvs.map((cv) => {
              const ext = cv.pdf_storage_path?.endsWith(".docx") ? "DOCX" : "PDF";
              const created = new Date(cv.created_at).toLocaleDateString("en-AU", {
                day: "numeric", month: "short", year: "numeric",
              });
              return (
                <li key={cv.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-text truncate">
                        {cv.label}
                      </span>
                      <span className="text-[10px] text-text-3 bg-surface-2 border border-border px-1.5 py-0.5 rounded">
                        {ext}
                      </span>
                      {cv.is_active && (
                        <span className="text-[10px] text-green bg-green-light border border-green/20 px-1.5 py-0.5 rounded">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-3 mt-0.5">Uploaded {created}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!cv.is_active && (
                      <button
                        onClick={() => handleSetActive(cv.id)}
                        disabled={pendingId === cv.id}
                        className="gh-btn text-[12px]"
                      >
                        Set active
                      </button>
                    )}
                    <button
                      onClick={() => setDeleteTarget(cv)}
                      disabled={pendingId === cv.id}
                      className="gh-btn gh-btn-danger text-[12px]"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Delete confirm modal — same pattern as DeleteProfileButton */}
      {deleteTarget && typeof window !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-[#1F2328]/40 backdrop-blur-sm"
            onClick={() => !deleting && setDeleteTarget(null)}
          />
          <div className="relative bg-white rounded-lg border border-[#D0D7DE] shadow-xl max-w-md w-full p-6">
            <h2 className="text-[16px] font-semibold text-[#1F2328] mb-2">Delete this CV?</h2>
            <p className="text-[13px] text-[#656D76] leading-relaxed mb-2">
              This removes <strong className="text-[#1F2328]">{deleteTarget.label}</strong>{" "}
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
