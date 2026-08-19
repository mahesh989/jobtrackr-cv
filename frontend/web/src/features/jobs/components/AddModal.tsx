"use client";

/**
 * AddModal — lets the user add a job they found anywhere on the web.
 *
 * One form, no tabs (demo `.modal-body .stack`): every field is visible from
 * the start. Paste a listing URL and "Fetch" fills the rest in for you;
 * otherwise just type them yourself. Both paths end at the same Save.
 *
 * On save → addManualJob() inserts into the user's "Saved Jobs" profile,
 * then optionally kicks off analysis immediately.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, X } from "lucide-react";
import { Modal, Button, Input, Textarea } from "@/components/ui";
import { addManualJob } from "@/lib/actions/jobs";

export function AddModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();

  const [url, setUrl]           = useState("");
  const [title, setTitle]       = useState("");
  const [company, setCompany]   = useState("");
  const [location, setLocation] = useState("");
  const [jd, setJd]             = useState("");

  const [fetching, setFetching]     = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched]       = useState(false);

  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Fetch from the listing URL → fills every field below ──────────────────
  async function handleFetch() {
    if (!url.trim() || fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/jobs/scrape-url", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch job page");
      setTitle(data.title ?? "");
      setCompany(data.company ?? "");
      setLocation(data.location ?? "");
      setJd(data.description ?? "");
      if (data.source_url) setUrl(data.source_url);
      setFetched(true);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Could not fetch the page");
    } finally {
      setFetching(false);
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave(analyseNow: boolean) {
    if (!title.trim() || jd.trim().length < 50) {
      setSaveError("Job title and a job description (50+ characters) are required.");
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
        source_url:  url.trim() || null,
      });

      if (result.alreadyExisted) {
        setSaveError("This job URL already exists in your Saved Jobs.");
        setSaving(false);
        return;
      }

      onClose();
      if (analyseNow) {
        // C67: a rejected analyze call (billing cap, validation error, ...)
        // or a network failure both fell into the SAME `.catch(() =>
        // router.refresh())` as a clean non-2xx response — silently
        // discarded, with the modal already closed by this point (onClose()
        // above), so there was no path left for the user to learn the job
        // WAS saved but analysis was NOT actually started.
        await fetch(`/api/jobs/${result.jobId}/analyze`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    "{}",
        }).then(async (r) => {
          if (r.ok) {
            const { run_id } = await r.json();
            router.push(`/jobs/${result.jobId}/analyze/${run_id}`);
          } else {
            const j = await r.json().catch(() => ({}));
            router.refresh();
            window.alert(`Job saved, but analysis could not start: ${j.error ?? `Failed (${r.status})`}`);
          }
        }).catch((e) => {
          router.refresh();
          window.alert(`Job saved, but analysis could not start: ${e instanceof Error ? e.message : "network error"}`);
        });
      } else {
        router.refresh();
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save job");
      setSaving(false);
    }
  }

  const canSave = title.trim().length > 0 && jd.trim().length >= 50;

  return (
    <Modal open onClose={onClose} size="md">
        {/* Demo `.modal-head`: small uppercase eyebrow + title, close icon. */}
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div>
            <p className="text-micro font-semibold uppercase tracking-[0.08em] text-text-3">Jobs</p>
            <h2 className="text-lead font-bold text-text mt-0.5">Add a job</h2>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="text-text-3 hover:text-text mt-0.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — demo `.modal-body .stack`: one full-width field per row,
            all visible at once. The URL sits first because fetching it fills
            in everything below. */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          <div>
            <label className="block text-label font-medium text-text-2 mb-1">Listing URL</label>
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setFetchError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleFetch(); } }}
                placeholder="https://www.seek.com.au/job/123456"
                disabled={fetching}
                className="field flex-1 text-body"
                autoFocus
              />
              <Button
                variant="brand"
                size="sm"
                type="button"
                onClick={handleFetch}
                disabled={fetching || !url.trim()}
                isLoading={fetching}
                className="inline-flex items-center gap-1.5 shrink-0"
              >
                {!fetching && <Link2 className="w-3.5 h-3.5" />}
                Fetch
              </Button>
            </div>
            <p className="text-caption text-text-3 mt-1">
              Paste a link and hit Fetch to fill the fields below automatically — or just fill them in yourself.
            </p>
          </div>

          {fetchError && (
            <p className="text-label text-danger bg-danger-subtle border border-danger-border rounded px-3 py-2">
              {fetchError} — fill the fields in manually instead.
            </p>
          )}
          {fetched && !fetchError && (
            <p className="text-label text-success bg-success-subtle border border-success-border rounded px-3 py-2">
              ✓ Job details fetched — review and edit below, then save.
            </p>
          )}

          <Input
            label="Job title *"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Personal Care Worker"
          />
          <Input
            label="Company"
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="e.g. Bolton Clarke"
          />
          <Input
            label="Location"
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Sydney NSW"
          />
          <div>
            <Textarea
              label="Job description *"
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              rows={7}
              placeholder="Paste the full job description here. Trim company blurbs and EEO statements to focus the AI on responsibilities and requirements."
              className="text-label font-mono resize-y"
              spellCheck={false}
            />
            {jd.trim().length > 0 && jd.trim().length < 200 && (
              <p className="text-caption text-warning mt-1">
                Too short for reliable analysis — paste more of the JD (aim for 200+ chars).
              </p>
            )}
          </div>

          {saveError && (
            <p className="text-label text-danger bg-danger-subtle border border-danger-border rounded px-3 py-2">
              {saveError}
            </p>
          )}
        </div>

        {/* Footer — demo `.modal-foot`: plain bordered bar, right-aligned. */}
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <Button size="sm" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={() => handleSave(false)}
            disabled={saving || !canSave}
            isLoading={saving}
          >
            Save
          </Button>
          <Button
            variant="brand"
            size="sm"
            type="button"
            onClick={() => handleSave(true)}
            disabled={saving || !canSave}
            isLoading={saving}
          >
            Save &amp; Analyse
          </Button>
        </div>
    </Modal>
  );
}
