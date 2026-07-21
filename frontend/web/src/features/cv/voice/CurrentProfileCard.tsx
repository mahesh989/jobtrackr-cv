"use client";

import { useState } from "react";
import { ChevronDown, Eye, Plus, Pencil } from "lucide-react";
import { TrustBadge } from "./TrustBadge";
import { sourceLabel, type VoiceProfile } from "./types";

interface Props {
  profile: VoiceProfile;
  onEdit: (prefill?: string) => void;
  onReplace: () => void;
}

export function CurrentProfileCard({ profile, onEdit, onReplace }: Props) {
  const [showSample, setShowSample] = useState(false);

  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-[var(--text)]">Current writing sample</p>
          <p className="text-caption text-[var(--sidebar-text-dim)]">
            {sourceLabel(profile.voice_sample_source)}
            {" · Last updated "}
            {new Date(profile.updated_at).toLocaleDateString("en-GB", {
              day: "numeric", month: "short", year: "numeric",
            })}
          </p>
        </div>
        <TrustBadge score={profile.voice_sample_trust_score} />
      </div>

      {profile.voice_sample_raw && (
        <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
          <button onClick={() => setShowSample((v) => !v)} className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] transition-colors">
            <span className="inline-flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              {showSample ? "Hide saved sample" : "View saved sample"}
            </span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSample ? "rotate-180" : ""}`} />
          </button>
          {showSample && (
            <div className="border-t border-[var(--card-border)] px-3 py-3 bg-[var(--surface-2)]">
              <p className="whitespace-pre-wrap text-label leading-relaxed text-[var(--text-2)] font-sans">
                {profile.voice_sample_raw}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button onClick={() => onEdit(profile.voice_sample_raw ?? "")} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--brand)] text-[var(--brand)] text-xs font-semibold hover:bg-[var(--brand)] hover:text-[var(--brand-fg)] transition-colors">
          <Pencil className="w-3.5 h-3.5" />
          Edit current sample
        </button>
        <button onClick={onReplace} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--card-border)] text-[var(--text-2)] text-xs font-semibold hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors">
          <Plus className="w-3.5 h-3.5" />
          Replace with a new sample
        </button>
        <span className="text-caption text-[var(--sidebar-text-dim)] ml-auto">
          Saving any new text replaces the current sample.
        </span>
      </div>
    </div>
  );
}
