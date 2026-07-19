"use client";

import { createPortal } from "react-dom";
import { Button } from "@/components/ui";
import { CheckCircle2, Loader2, X } from "lucide-react";

const UPLOAD_MESSAGES = [
  "Uploading your CV…",
  "Analysing the sections…",
  "Almost there — tidying things up…",
];

interface UploadProgressModalProps {
  phase:          "uploading" | "success";
  step:           number;
  onDismiss:      () => void;
  onProceed:      () => void;
}

export function UploadProgressModal({ phase, step, onDismiss, onProceed }: UploadProgressModalProps) {
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl"
      >
        <Button
          variant="default"
          size="sm"
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full p-1.5"
        >
          <X className="h-4 w-4" />
        </Button>

        <div className="flex flex-col items-center text-center pt-3">
          {phase === "uploading" ? (
            <>
              <Loader2 className="h-11 w-11 animate-spin text-[var(--brand)]" aria-hidden="true" />
              <p className="mt-4 text-[15px] font-semibold text-text" aria-live="polite">
                {UPLOAD_MESSAGES[step]}
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
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={onProceed}
                className="mt-5 rounded-full px-7 py-2 text-[13px] font-medium"
              >
                OK
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface DeleteConfirmModalProps {
  target:     { id: string; label: string; is_active: boolean } | null;
  deleting:   boolean;
  onCancel:   () => void;
  onConfirm:  () => void;
}

export function DeleteConfirmModal({ target, deleting, onCancel, onConfirm }: DeleteConfirmModalProps) {
  if (!target) return null;
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-text/40 backdrop-blur-sm"
        onClick={() => !deleting && onCancel()}
      />
      <div className="relative bg-surface rounded-lg border border-[var(--border)] shadow-xl max-w-md w-full p-6">
        <h2 className="text-[16px] font-semibold text-text mb-2">Delete this CV?</h2>
        <p className="text-[13px] text-text-2 leading-relaxed mb-2">
          This removes <strong className="text-text">{target.label}</strong>{" "}
          from your library and deletes the file from storage.
          {target.is_active && (
            <> It is currently your <strong>active</strong> CV — after deletion you will need to set another active before running an analysis.</>
          )}
        </p>
        <p className="text-[12px] text-[#CF222E] font-medium mb-5">This action cannot be undone.</p>
        <div className="flex gap-2 justify-end">
          <Button
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Yes, delete"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
