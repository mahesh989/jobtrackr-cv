"use client";

/**
 * Autosave for the CV review editor — extracted from ReviewClient.
 *
 * Owns the whole persistence lifecycle: the debounce timer, the
 * last-server-acknowledged snapshot used for dirty-checking, the flush paths
 * that fire when the tab is hidden or the component unmounts, and the
 * save/error status the UI renders.
 *
 * WHY THE REFS EXIST — each guards a silent failure mode, so none of them is
 * incidental:
 *   `lastSaved`  the snapshot the server has actually acknowledged. Only
 *                advanced on a 2xx, so a failed save leaves the doc dirty and
 *                a later flush retries it instead of dropping the edit.
 *   `latest`     mirrors the newest {doc, customSects}. The unmount cleanup
 *                registers once, so without this it would close over the state
 *                as of mount and flush stale text.
 *   `timer`      the pending debounce. Cleared before every flush, otherwise a
 *                flush plus the timer both fire and the CV is saved twice.
 *
 * Behaviour is pinned by ReviewClient.autosave.test.tsx, which was written
 * against the pre-extraction component and mutation-tested.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomCvSection, StructuredCv } from "@/lib/cv/backend";
import type { SaveStatus } from "./ReviewComponents";

export const AUTOSAVE_MS = 10_000;

// Canonical serialization used for dirty-checking — must build the payload
// exactly the way persist() does so snapshot comparison is byte-accurate.
export const serializeCv = (d: StructuredCv, cs: CustomCvSection[]) =>
  JSON.stringify({ ...d, custom_sections: cs });

export interface ReviewAutosave {
  /** Current save state, for the badge and the toast. */
  save:   SaveStatus;
  /** Server error message from the last failed save, if any. */
  err:    string | null;
  /** structured_cv_status as last reported by the server. */
  status: string;
  /** Write now. Returns false when the server rejected the payload. */
  persist: (
    next: StructuredCv,
    cs: CustomCvSection[],
    verified: boolean,
    opts?: { keepalive?: boolean },
  ) => Promise<boolean>;
  /** Cancel a pending debounce — call before an explicit save. */
  cancelPending: () => void;
}

export function useReviewAutosave({
  cvId, doc, customSects, initialStructuredCv, initialStatus, enabled,
}: {
  cvId:                string;
  doc:                 StructuredCv;
  customSects:         CustomCvSection[];
  initialStructuredCv: StructuredCv;
  initialStatus:       string;
  /** False in create mode: the user saves explicitly, nothing autosaves. */
  enabled:             boolean;
}): ReviewAutosave {
  const [status, setStatus] = useState<string>(initialStatus);
  const [save,   setSave]   = useState<SaveStatus>("idle");
  const [err,    setErr]    = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Snapshot of the last server-acknowledged payload. Autosave only fires
  // when the current state actually differs from this — no diff, no request.
  const lastSaved = useRef<string>(serializeCv(initialStructuredCv,
    (initialStructuredCv as { custom_sections?: CustomCvSection[] }).custom_sections ?? []));

  const persist = useCallback(async (next: StructuredCv, cs: CustomCvSection[], verified: boolean, opts?: { keepalive?: boolean }) => {
    setSave("saving");
    setErr(null);
    try {
      const payload = { ...next, custom_sections: cs };
      const res = await fetch(`/api/cv/${cvId}/structured`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ structured_cv: payload, verified }),
        // keepalive lets the request survive the page being torn down
        // (tab close / navigation) — used only by the dirty-flush paths.
        keepalive: opts?.keepalive ?? false });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setSave("error");
        setErr(j.error ?? `Save failed (${res.status})`);
        return false;
      }
      lastSaved.current = JSON.stringify(payload);
      const j = await res.json() as { structured_cv_status: string };
      setStatus(j.structured_cv_status);
      setSave("saved");
      return true;
    } catch (e) {
      setSave("error");
      setErr(e instanceof Error ? e.message : "Save failed");
      return false;
    }
  }, [cvId]);

  const cancelPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    // Create mode: no autosave — user saves explicitly via the Save button.
    if (!enabled) return;
    // Dirty-check: skip when nothing actually changed (also covers the
    // initial mount and StrictMode's dev double-mount — same snapshot, no-op).
    if (serializeCv(doc, customSects) === lastSaved.current) return;
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(doc, customSects, false); }, AUTOSAVE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [doc, customSects, persist, enabled]);

  // Flush a dirty buffer when the tab is hidden or the page is torn down —
  // otherwise an edit made within AUTOSAVE_MS of leaving would be lost.
  useEffect(() => {
    if (!enabled) return;
    const flushIfHidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (serializeCv(doc, customSects) === lastSaved.current) return;
      if (timer.current) clearTimeout(timer.current);
      void persist(doc, customSects, false, { keepalive: true });
    };
    document.addEventListener("visibilitychange", flushIfHidden);
    window.addEventListener("pagehide", flushIfHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHidden);
      window.removeEventListener("pagehide", flushIfHidden);
    };
  }, [doc, customSects, persist, enabled]);

  // Same flush for in-app navigation (e.g. "Back to Profile"), which unmounts
  // the component without firing pagehide. Latest state is read via a ref so
  // this effect registers its cleanup once.
  const latest = useRef({ doc, customSects });
  useEffect(() => { latest.current = { doc, customSects }; }, [doc, customSects]);
  useEffect(() => {
    if (!enabled) return;
    return () => {
      const { doc: d, customSects: cs } = latest.current;
      if (serializeCv(d, cs) === lastSaved.current) return;
      if (timer.current) clearTimeout(timer.current);
      void persist(d, cs, false, { keepalive: true });
    };
  }, [enabled, persist]);

  return { save, err, status, persist, cancelPending };
}
