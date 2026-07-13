"use client";

/**
 * AddJobModal — lets the user add a job they found anywhere on the web.
 *
 * Two paths:
 *   1. Paste a URL → we fetch + parse the page, pre-fill all fields
 *   2. Paste the JD directly → manual entry with title/company/location fields
 *
 * On save → addManualJob() inserts into the user's "Saved Jobs" profile,
 * then optionally kicks off analysis immediately.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Link2, FileText, X } from "lucide-react";
import { Modal } from "@/components/ui";
import { addManualJob } from "@/lib/actions";

type Tab = "url" | "paste";

interface Prefilled {
  title:       string;
  company:     string;
  location:    string;
  description: string;
  source_url:  string;
}

export function AddJobModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [tab, setTab]       = useState<Tab>("url");

  // URL tab state
  const [url, setUrl]       = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState<Prefilled | null>(null);

  // Shared fields
  const [title, setTitle]       = useState("");
  const [company, setCompany]   = useState("");
  const [location, setLocation] = useState("");
  const [jd, setJd]             = useState("");

  // Save state
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── URL fetch ──────────────────────────────────────────────────────────────
  async function handleFetch() {
    if (!url.trim()) return;
    setFetching(true);
    setFetchError(null);
    setPrefilled(null);
    try {
      const res = await fetch("/api/jobs/scrape-url", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch job page");
      const p: Prefilled = {
        title:       data.title       ?? "",
        company:     data.company     ?? "",
        location:    data.location    ?? "",
        description: data.description ?? "",
        source_url:  data.source_url  ?? url.trim(),
      };
      setPrefilled(p);
      setTitle(p.title);
      setCompany(p.company);
      setLocation(p.location);
      setJd(p.description);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Could not fetch the page");
    } finally {
      setFetching(false);
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave(analyseNow: boolean) {
    if (!title.trim() || !jd.trim()) {
      setSaveError("Title and job description are required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await addManualJob({
        title,
        company:     company || null,
        location:    location || null,
        description: jd,
        source_url:  (tab === "url" ? prefilled?.source_url : null) ?? null,
      });

      if (result.alreadyExisted) {
        setSaveError("This job URL already exists in your Saved Jobs.");
        setSaving(false);
        return;
      }

      onClose();
      if (analyseNow) {
        await fetch(`/api/jobs/${result.jobId}/analyze`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    "{}",
        }).then(async (r) => {
          if (r.ok) {
            const { run_id } = await r.json();
            router.push(`/dashboard/jobs/${result.jobId}/analyze/${run_id}`);
          } else {
            router.refresh();
          }
        }).catch(() => router.refresh());
      } else {
        router.refresh();
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save job");
      setSaving(false);
    }
  }

  const canSave = title.trim().length > 0 && jd.trim().length >= 50;
  const showFields = tab === "paste" || prefilled !== null;

  return (
    <Modal open onClose={onClose} size="md">
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-text">Add a job</h2>
            <p className="text-[12px] text-text-2 mt-0.5">
              Found a job elsewhere? Add it here to analyse and track it.
            </p>
          </div>
          <button onClick={onClose} disabled={saving} className="text-text-3 hover:text-text mt-0.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="px-5 pt-3 flex gap-1">
          {([["url", Link2, "Fetch from URL"], ["paste", FileText, "Paste JD"]] as const).map(([t, Icon, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setPrefilled(null); setFetchError(null); }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                tab === t
                  ? "bg-[var(--brand)] text-white"
                  : "bg-[var(--surface-2)] text-text-2 hover:bg-[var(--surface)] hover:text-text"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">

          {/* URL input */}
          {tab === "url" && (
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFetch()}
                placeholder="https://www.seek.com.au/job/123456"
                disabled={fetching}
                className="field flex-1 text-[13px]"
                autoFocus
              />
              <button
                type="button"
                onClick={handleFetch}
                disabled={fetching || !url.trim()}
                className="gh-btn gh-btn-primary text-[12px] px-3 inline-flex items-center gap-1.5 disabled:opacity-50 shrink-0"
              >
                {fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                Fetch
              </button>
            </div>
          )}

          {fetchError && (
            <p className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {fetchError} — try the &quot;Paste JD&quot; tab instead.
            </p>
          )}

          {/* Pre-filled confirmation (URL tab) */}
          {tab === "url" && prefilled && (
            <p className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
              ✓ Job details fetched — review and edit below, then save.
            </p>
          )}

          {/* Shared fields — shown once we have something to edit */}
          {showFields && (
            <>
              <div>
                <label className="block text-[11px] font-semibold text-text-2 mb-1">Job title <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Personal Care Worker"
                  className="field w-full text-[13px]"
                  autoFocus={tab === "paste"}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-text-2 mb-1">Company</label>
                  <input
                    type="text"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="e.g. Bolton Clarke"
                    className="field w-full text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-text-2 mb-1">Location</label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. Sydney NSW"
                    className="field w-full text-[13px]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-text-2 mb-1">
                  Job description <span className="text-red-500">*</span>
                  <span className="text-text-3 font-normal ml-2">{jd.trim().length} chars · {Math.round(jd.trim().split(/\s+/).filter(Boolean).length)} words</span>
                </label>
                <textarea
                  value={jd}
                  onChange={(e) => setJd(e.target.value)}
                  rows={7}
                  placeholder="Paste the full job description here. Trim company blurbs and EEO statements to focus the AI on responsibilities and requirements."
                  className="field w-full text-[12px] font-mono resize-y"
                  spellCheck={false}
                />
                {jd.trim().length > 0 && jd.trim().length < 200 && (
                  <p className="text-[11px] text-amber-600 mt-1">
                    Too short for reliable analysis — paste more of the JD (aim for 200+ chars).
                  </p>
                )}
              </div>
            </>
          )}

          {saveError && (
            <p className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {saveError}
            </p>
          )}
        </div>

        {/* Footer */}
        {showFields && (
          <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-between gap-2 bg-[var(--surface-2)] rounded-b-lg">
            <span className="text-[11px] text-text-3">
              Saved to your <strong className="text-text-2">Saved Jobs</strong> profile
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleSave(false)}
                disabled={saving || !canSave}
                className="gh-btn text-[12px] disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Save
              </button>
              <button
                type="button"
                onClick={() => handleSave(true)}
                disabled={saving || !canSave}
                className="gh-btn gh-btn-primary text-[12px] disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Save &amp; Analyse
              </button>
            </div>
          </div>
        )}
    </Modal>
  );
}
