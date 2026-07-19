"use client";

import { Button } from "@/components/ui";
import { useProfile } from "./context";

export function ProfileSaveBar() {
  const { dirty, saving, saved, error, save } = useProfile();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
      <Button
        variant="primary"
        size="md"
        type="button"
        onClick={save}
        disabled={saving}
        className="transition-shadow hover:glow-gold"
      >
        {saving ? "Saving…" : "Save details"}
      </Button>
      <span className="text-[12px] text-text-2">
        {error ? <span className="text-red">{error}</span>
          : saved ? <span className="text-green-600 font-medium">✓ Saved</span>
          : dirty ? "Unsaved changes — contact, verticals, credentials & references."
          : "Applies to every CV."}
      </span>
    </div>
  );
}
