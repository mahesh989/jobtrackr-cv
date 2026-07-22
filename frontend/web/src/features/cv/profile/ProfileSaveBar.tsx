"use client";

import { Loader2, Check } from "lucide-react";
import { useProfile } from "./ProfileDetailsContext";
import { Button } from "@/components/ui";

/**
 * AutoSaveBadge — passive status line for pages that rely purely on the
 * provider's autosave (no Save button, no required-field validation).
 * Used on the Credentials tab, where every control is a toggle/select and
 * changes persist on their own.
 */
export function AutoSaveBadge() {
  const { autoStatus } = useProfile();
  return (
    <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3 text-label text-text-2">
      {autoStatus === "pending" || autoStatus === "saving" ? (
        <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Saving…</>
      ) : autoStatus === "saved" ? (
        <><Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" /><span className="text-green-600 font-medium">Saved</span></>
      ) : autoStatus === "error" ? (
        <span className="text-red">Couldn&apos;t save — check your connection; your next change will retry.</span>
      ) : (
        <>Changes save automatically. Applies to every CV.</>
      )}
    </div>
  );
}

export function ProfileSaveBar() {
  const { dirty, saving, saved, error, save } = useProfile();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
      <Button
        type="button"
        variant="brand"
        size="sm"
        onClick={save}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save details"}
      </Button>
      <span className="text-label text-text-2">
        {error ? <span className="text-red">{error}</span>
          : saved ? <span className="text-green-600 font-medium">✓ Saved</span>
          : dirty ? "Unsaved changes — contact, verticals, credentials & references."
          : "Applies to every CV."}
      </span>
    </div>
  );
}
