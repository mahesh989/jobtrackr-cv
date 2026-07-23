"use client";

import { useState, useTransition } from "react";
import { Button, Modal } from "@/components/ui";
import { deleteProfile } from "@/lib/actions/profiles";

export function DeleteButton({
  profileId,
  profileName,
  compact = false,
}: {
  profileId: string;
  profileName: string;
  compact?: boolean;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      await deleteProfile(profileId);
    });
  }

  return (
    <>
      {compact ? (
        <Button
          size="sm"
          type="button"
          onClick={() => setShowConfirm(true)}
          title={`Delete "${profileName}"`}
          className="text-text-3 hover:text-[var(--red)] hover:border-[var(--red)]/30 hover:bg-[var(--red-light)]"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </Button>
      ) : (
        <Button
          variant="danger"
          size="sm"
          type="button"
          onClick={() => setShowConfirm(true)}
        >
          Delete profile
        </Button>
      )}

      <Modal
        open={showConfirm}
        onClose={() => !pending && setShowConfirm(false)}
        size="sm"
      >
        <div className="p-6">
          <h2 className="text-lead font-semibold text-text mb-2">Delete profile?</h2>
          <p className="text-body text-text-2 leading-relaxed mb-2">
            This will permanently delete <strong className="text-text">{profileName}</strong> and all its associated jobs, run history, and settings.
          </p>
          <p className="text-label text-[var(--red)] font-medium mb-5">This action cannot be undone.</p>

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              onClick={() => setShowConfirm(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              type="button"
              onClick={handleDelete}
              disabled={pending}
            >
              {pending ? "Deleting…" : "Yes, delete"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
