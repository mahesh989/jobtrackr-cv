"use client";

import { useProfile } from "./context";

export function ProfileSaveBar() {
  const { dirty, saving, saved, error, save } = useProfile();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-shadow hover:opacity-90 hover:glow-gold disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save details"}
      </button>
      <span className="text-[12px] text-text-2">
        {error ? <span className="text-red">{error}</span>
          : saved ? <span className="text-green-600 font-medium">✓ Saved</span>
          : dirty ? "Unsaved changes — contact, verticals, credentials & references."
          : "Applies to every CV."}
      </span>
    </div>
  );
}
