"use client";

import Link from "next/link";
import { UserCheck } from "lucide-react";
import { useProfile, type ReferencesMode } from "./ProfileDetailsContext";
import { SectionCard } from "./ProfileFormComponents";

const REF_MODES: { value: ReferencesMode; label: string; description: string }[] = [
  { value: "details",    label: "Include referee details", description: "Referee names, titles, and emails are printed on your CV." },
  { value: "on_request", label: "Available on request",    description: 'Your CV shows "References available on request."' },
  { value: "none",       label: "Don't include in CV",     description: "References section is omitted from your CV entirely." },
];

export function ReferencesSection() {
  const { refMode, setRefMode, activeCvId } = useProfile();

  return (
    <SectionCard icon={UserCheck} title="References" subtitle="Applies to all CVs. Up to 3 referees.">
      <div className="space-y-2">
        {REF_MODES.map((opt) => (
          <label key={opt.value} className={`flex items-start gap-3 cursor-pointer rounded-lg border px-4 py-3 transition-colors ${refMode === opt.value ? "border-[var(--brand)]/50 bg-[var(--brand)]/5" : "border-border hover:bg-surface-2/60"}`}>
            <input type="radio" name="references-mode" value={opt.value} checked={refMode === opt.value} onChange={() => setRefMode(opt.value)} className="mt-0.5 h-4 w-4 accent-[var(--brand)] cursor-pointer shrink-0" />
            <div>
              <span className={`text-body font-medium ${refMode === opt.value ? "text-[var(--brand)]" : "text-text"}`}>{opt.label}</span>
              <p className="text-caption text-text-3 mt-0.5">{opt.description}</p>
            </div>
          </label>
        ))}
      </div>

      {refMode === "details" && (
        <p className="text-label text-text-3 rounded-lg border border-border bg-surface-2/40 px-4 py-3">
          Referees are taken from your active CV.{" "}
          {activeCvId
            ? <>Edit them in the CV&apos;s <Link href={`/cv/${activeCvId}/review?section=references`} className="font-medium text-[var(--brand)] hover:underline">Review form</Link>.</>
            : "Upload a CV and edit them in its Review form."}
        </p>
      )}
    </SectionCard>
  );
}
