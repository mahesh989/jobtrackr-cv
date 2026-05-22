"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X, Save } from "lucide-react";

interface Props {
  letterId: string;
  onClose:  () => void;
}

/**
 * Modal for editing the cover letter body (cover_letters.pass_3_final).
 *
 * Flow:
 *   1. Open → fetch full pass_3_final from GET /api/applications/[letter_id]
 *      (the list view only carries a truncated preview)
 *   2. User edits in a textarea
 *   3. Save → PATCH /api/applications/[letter_id] {pass_3_final}
 *      The route clears pdf_storage_path so the next Letter download or
 *      Send-email lazy-re-renders the PDF from the new text.
 *   4. router.refresh() to repopulate the card preview from server data.
 *
 * Already-sent letters are blocked server-side (409 response surfaced
 * inline). No edits to outgoing record.
 */
export function EditLetterModal({ letterId, onClose }: Props) {
  const router = useRouter();
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [text, setText]         = useState("");
  const [original, setOriginal] = useState("");
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res  = await fetch(`/api/applications/${letterId}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `Load failed (${res.status})`);
          return;
        }
        setText(json.pass_3_final ?? "");
        setOriginal(json.pass_3_final ?? "");
        if (json.email_sent_at) {
          setError("This letter has already been sent — edits won't change the outgoing email.");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [letterId]);

  // Escape closes the modal (unless saving)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  async function handleSave() {
    if (saving || loading) return;
    if (text.trim() === original.trim()) {
      // No-op
      onClose();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res  = await fetch(`/api/applications/${letterId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pass_3_final: text }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      // Refresh the parent server component so the truncated preview updates.
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSaving(false);
    }
  }

  const dirty = text.trim() !== original.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-text">Edit cover letter</h2>
            <p className="text-[11px] text-text-3 mt-0.5">
              Changes here update the letter body, the downloadable PDF, and what gets emailed.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-text-3 hover:text-text disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-3 flex-1 overflow-hidden flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-text-3 text-[12px]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={saving}
              className="flex-1 w-full text-[13px] leading-relaxed px-3 py-2 border border-border rounded font-mono bg-surface text-text resize-none focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
              spellCheck
              style={{ minHeight: 360 }}
            />
          )}
          {error && (
            <div className="mt-2 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2">
              <p className="text-[12px] text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <span className="text-[11px] text-text-3 mr-auto">
            {text.length} chars{dirty && " · unsaved changes"}
          </span>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-[12px] text-text-2 hover:text-text px-3 py-1.5 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || !dirty}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5 disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
