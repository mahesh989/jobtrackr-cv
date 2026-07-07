"use client";

import { useState } from "react";
import { Plus, Trash2, Save, UserCheck, Sparkles } from "lucide-react";

export interface Referee {
  name:      string;
  job_title: string;
  company:   string;
  email:     string;
}

export type ReferencesMode = "details" | "on_request" | "none";

export interface ReferencesData {
  mode?:                 ReferencesMode;
  /** Legacy field — mapped to mode on load */
  available_on_request?: boolean;
  referees?:             Referee[];
}

const MAX_REFEREES = 3;

const emptyReferee = (): Referee => ({ name: "", job_title: "", company: "", email: "" });

function isBlank(r: Referee) {
  return !r.name.trim() && !r.job_title.trim() && !r.company.trim() && !r.email.trim();
}

function resolveInitialMode(data: ReferencesData | null): ReferencesMode {
  if (!data) return "none";
  if (data.mode) return data.mode;
  // backwards-compat: map old boolean field
  return data.available_on_request ? "on_request" : "details";
}

const MODES: { value: ReferencesMode; label: string; description: string }[] = [
  {
    value:       "details",
    label:       "Include referee details",
    description: "Referee names, titles, and emails are printed on your CV.",
  },
  {
    value:       "on_request",
    label:       "Available on request",
    description: 'Your CV will show "References available on request."',
  },
  {
    value:       "none",
    label:       "Don\'t include in CV",
    description: "References section is omitted from your CV entirely.",
  },
];

export function ReferencesSection({
  initial,
  contactDetails,
  activeCvId,
  extractedReferences,
}: {
  initial:             ReferencesData | null;
  contactDetails:      Record<string, unknown>;
  /** ID of the user's active (or most recent) CV — null if none uploaded yet. */
  activeCvId:          string | null;
  /** Cached AI-extracted referees from a prior run; null if never extracted. */
  extractedReferences: Referee[] | null;
}) {
  const [mode, setMode]         = useState<ReferencesMode>(resolveInitialMode(initial));
  const [referees, setReferees] = useState<Referee[]>(
    initial?.referees?.length ? initial.referees : [],
  );
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [extracting, setExtracting]   = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  /** Latest extracted list — starts from the server-cached value but can be
   *  refreshed by the extract button. */
  const [extracted, setExtracted] = useState<Referee[] | null>(extractedReferences);

  function updateReferee(idx: number, field: keyof Referee, value: string) {
    setReferees((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
    setSaved(false);
  }

  function addReferee() {
    if (referees.length >= MAX_REFEREES) return;
    setReferees((prev) => [...prev, emptyReferee()]);
    setSaved(false);
  }

  function removeReferee(idx: number) {
    setReferees((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  /** Call the AI extractor on the active CV. Result is cached on the server
   *  and also held in local state for "Use these" copying. */
  async function handleExtract() {
    if (!activeCvId) return;
    setExtractError(null);
    setExtracting(true);

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

  /** Copy the extracted referees into the editable form. User still has to
   *  hit "Save references" to commit them to user_preferences. */
  function useExtracted() {
    if (!extracted?.length) return;
    setReferees(extracted.slice(0, MAX_REFEREES));
    setMode("details");
    setSaved(false);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    setSaved(false);

    const cleaned = referees.filter((r) => !isBlank(r));

    try {
      const res = await fetch("/api/user/preferences", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_details: {
            ...contactDetails,
            references: {
              mode,
              referees: cleaned,
            },
          },
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setReferees(cleaned);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <UserCheck className="h-4 w-4 text-text-3" />
        <h2 className="text-[14px] font-semibold text-text">References</h2>
      </div>

      {/* 3-option radio group */}
      <div className="space-y-2">
        {MODES.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-start gap-3 cursor-pointer rounded-lg border px-4 py-3 transition-colors ${
              mode === opt.value
                ? "border-[var(--brand)]/50 bg-[var(--brand)]/5"
                : "border-border hover:bg-surface-2/60"
            }`}
          >
            <input
              type="radio"
              name="references-mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => { setMode(opt.value); setSaved(false); }}
              className="mt-0.5 h-4 w-4 accent-[var(--brand)] cursor-pointer shrink-0"
            />
            <div>
              <span className={`text-[13px] font-medium ${mode === opt.value ? "text-[var(--brand)]" : "text-text"}`}>
                {opt.label}
              </span>
              <p className="text-[11px] text-text-3 mt-0.5">{opt.description}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Extract from CV — only in "details" mode, only when a CV exists */}
      {mode === "details" && activeCvId && (
        <div className="rounded-lg border border-[var(--brand)]/20 bg-[var(--brand)]/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className="h-3.5 w-3.5 text-[var(--brand)]" />
                <span className="text-[12px] font-semibold text-text">Pre-fill from your CV</span>
              </div>
              <p className="text-[11px] text-text-3 leading-relaxed">
                Use AI to extract referees already listed in your active CV.
                Nothing is saved until you click &quot;Save references&quot; below.
              </p>
            </div>
            <button
              type="button"
              onClick={handleExtract}
              disabled={extracting}
              className="shrink-0 text-[12px] font-medium text-[var(--brand)] border border-[var(--brand)]/30 hover:bg-[var(--brand)]/10 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
            >
              {extracting ? "Extracting…" : extracted ? "Re-extract" : "Extract from CV"}
            </button>
          </div>

          {extractError && (
            <p className="text-[11px] text-red">{extractError}</p>
          )}

          {/* Show what we found */}
          {extracted !== null && !extracting && (
            extracted.length === 0 ? (
              <p className="text-[11px] text-text-3 italic">
                No referees found in your CV. You can add them manually below.
              </p>
            ) : (
              <div className="space-y-2 pt-1">
                <p className="text-[11px] text-text-3">
                  Found {extracted.length} {extracted.length === 1 ? "referee" : "referees"}:
                </p>
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
                <button
                  type="button"
                  onClick={useExtracted}
                  className="text-[12px] font-medium text-[var(--brand)] hover:underline"
                >
                  Use these →
                </button>
              </div>
            )
          )}
        </div>
      )}

      {/* Referee forms — only visible in "details" mode */}
      {mode === "details" && (
        <div className="space-y-3 pl-1">
          {referees.length === 0 && (
            <p className="text-[12px] text-text-3 italic">
              No referees added yet. Click &quot;Add referee&quot; to get started.
            </p>
          )}

          {referees.map((r, idx) => (
            <RefereeCard
              key={idx}
              index={idx}
              referee={r}
              onChange={(field, val) => updateReferee(idx, field, val)}
              onRemove={() => removeReferee(idx)}
            />
          ))}

          {referees.length < MAX_REFEREES && (
            <button
              type="button"
              onClick={addReferee}
              className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--brand)] hover:underline"
            >
              <Plus className="h-3.5 w-3.5" />
              Add referee{referees.length > 0 ? ` (${referees.length}/${MAX_REFEREES})` : ""}
            </button>
          )}

          {referees.length === MAX_REFEREES && (
            <p className="text-[11px] text-text-3">Maximum {MAX_REFEREES} referees reached.</p>
          )}
        </div>
      )}

      {/* Save row */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-4 py-2 text-[13px] font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save references"}
        </button>
        {saved  && <span className="text-[12px] text-green-600 font-medium">Saved</span>}
        {error  && <span className="text-[12px] text-red">{error}</span>}
      </div>
    </div>
  );
}

// ── Single referee card ────────────────────────────────────────────────────

function RefereeCard({
  index, referee, onChange, onRemove,
}: {
  index:    number;
  referee:  Referee;
  onChange: (field: keyof Referee, value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-3">
          Referee {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-text-3 hover:bg-red-light hover:text-red transition-colors"
          aria-label="Remove referee"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full name"             value={referee.name}      placeholder="e.g. Sarah Chen"            onChange={(v) => onChange("name", v)} />
        <Field label="Job title"             value={referee.job_title} placeholder="e.g. Head of Nursing"       onChange={(v) => onChange("job_title", v)} />
        <Field label="Company / Organisation" value={referee.company}   placeholder="e.g. Anglicare"             onChange={(v) => onChange("company", v)} />
        <Field label="Email"                 value={referee.email}     placeholder="e.g. sarah@anglicare.org.au" type="email" onChange={(v) => onChange("email", v)} />
      </div>
    </div>
  );
}

function Field({
  label, value, placeholder, type = "text", onChange,
}: {
  label: string; value: string; placeholder: string; type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-2">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="field text-[13px] py-1.5"
      />
    </label>
  );
}
