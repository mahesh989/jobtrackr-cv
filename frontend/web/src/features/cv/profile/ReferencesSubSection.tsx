"use client";

import { useState } from "react";
import { Plus, Trash2, Sparkles, UserCheck } from "lucide-react";
import type { Referee, ReferencesMode } from "@/features/cv/profile/ReferencesSection";
import { useProfile, MAX_REFEREES } from "./context";
import { SectionCard, Field } from "./primitives";
import { Radio, Button } from "@/ui";

const REF_MODES: { value: ReferencesMode; label: string; description: string }[] = [
  { value: "details",    label: "Include referee details", description: "Referee names, titles, and emails are printed on your CV." },
  { value: "on_request", label: "Available on request",    description: 'Your CV shows "References available on request."' },
  { value: "none",       label: "Don't include in CV",     description: "References section is omitted from your CV entirely." },
];

export function ReferencesSubSection() {
  const { refMode, setRefMode, referees, addReferee, removeReferee, patchReferee, setReferees, activeCvId } = useProfile();
  const [extracting, setExtracting]   = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extracted, setExtracted]     = useState<Referee[] | null>(null);

  async function handleExtract() {
    if (!activeCvId) return;
    setExtractError(null); setExtracting(true);
    try {
      const res = await fetch(`/api/cv/${activeCvId}/extract-references`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setExtractError(j.error ?? `Extraction failed (HTTP ${res.status})`);
        return;
      }
      const j = await res.json() as { referees: Referee[] };
      setExtracted(j.referees ?? []);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Network error — try again.");
    } finally {
      setExtracting(false);
    }
  }

  return (
    <SectionCard icon={UserCheck} title="References" subtitle="Applies to all CVs. Up to 3 referees.">
      <div className="space-y-2">
        {REF_MODES.map((opt) => (
          <div key={opt.value} className={`flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${refMode === opt.value ? "border-[var(--brand)]/50 bg-[var(--brand)]/5" : "border-border hover:bg-surface-2/60"}`}>
            <Radio name="references-mode" value={opt.value} checked={refMode === opt.value} onChange={() => setRefMode(opt.value)} label={opt.label} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-[11px] text-text-3 mt-0.5">{opt.description}</p>
            </div>
          </div>
        ))}
      </div>

      {refMode === "details" && activeCvId && (
        <div className="rounded-lg border border-[var(--brand)]/20 bg-[var(--brand)]/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className="h-3.5 w-3.5 text-[var(--brand)]" />
                <span className="text-[12px] font-semibold text-text">Pre-fill from your active CV</span>
              </div>
              <p className="text-[11px] text-text-3 leading-relaxed">Use AI to extract referees already listed in your active CV. Nothing saves until you hit Save details.</p>
            </div>
            <Button type="button" onClick={handleExtract} disabled={extracting} isLoading={extracting}
              className="shrink-0 text-[12px] font-medium text-[var(--brand)] border border-[var(--brand)]/30 hover:bg-[var(--brand)]/10 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50">
              {extracting ? "Extracting…" : extracted ? "Re-extract" : "Extract from CV"}
            </Button>
          </div>
          {extractError && <p className="text-[11px] text-red">{extractError}</p>}
          {extracted !== null && !extracting && (
            extracted.length === 0 ? (
              <p className="text-[11px] text-text-3 italic">No referees found in your CV. Add them manually below.</p>
            ) : (
              <div className="space-y-2 pt-1">
                <p className="text-[11px] text-text-3">Found {extracted.length} {extracted.length === 1 ? "referee" : "referees"}:</p>
                <ul className="space-y-1.5">
                  {extracted.map((r, i) => (
                    <li key={i} className="text-[11px] text-text-2 bg-surface rounded px-2 py-1.5 border border-border">
                      <span className="font-medium text-text">{r.name || "(unnamed)"}</span>
                      {r.job_title && <span> · {r.job_title}</span>}
                      {r.company && <span> · {r.company}</span>}
                      {r.email && <span className="text-text-3"> · {r.email}</span>}
                    </li>
                  ))}
                </ul>
                <Button type="button" onClick={() => { setReferees(extracted.slice(0, MAX_REFEREES)); setRefMode("details"); }} className="text-[12px] font-medium text-[var(--brand)] hover:underline">Use these →</Button>
              </div>
            )
          )}
        </div>
      )}

      {refMode === "details" && (
        <div className="space-y-3 pl-1">
          {referees.length === 0 && <p className="text-[12px] text-text-3 italic">No referees added yet.</p>}
          {referees.map((r, idx) => (
            <div key={idx} className="rounded-lg border border-border bg-surface p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-text-3">Referee {idx + 1}</span>
                <Button type="button" onClick={() => removeReferee(idx)} icon={<Trash2 className="h-3.5 w-3.5" />}
                  className="rounded p-1 text-text-3 hover:bg-red-light hover:text-red transition-colors" aria-label="Remove referee" />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Full name"              value={r.name      ?? ""} onChange={(v) => patchReferee(idx, "name", v)}      placeholder="e.g. Sarah Chen" />
                <Field label="Job title"              value={r.job_title ?? ""} onChange={(v) => patchReferee(idx, "job_title", v)} placeholder="e.g. Head of Nursing" />
                <Field label="Company / Organisation" value={r.company   ?? ""} onChange={(v) => patchReferee(idx, "company", v)}   placeholder="e.g. Anglicare" />
                <Field label="Email"                  value={r.email     ?? ""} onChange={(v) => patchReferee(idx, "email", v)}     placeholder="e.g. sarah@anglicare.org.au" type="email" />
              </div>
            </div>
          ))}
          {referees.length < MAX_REFEREES && (
            <Button type="button" onClick={addReferee} icon={<Plus className="h-3.5 w-3.5" />}
              className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--brand)] hover:underline">
              Add referee{referees.length > 0 ? ` (${referees.length}/${MAX_REFEREES})` : ""}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}
