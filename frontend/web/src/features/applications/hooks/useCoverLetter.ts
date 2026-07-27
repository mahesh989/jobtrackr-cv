"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * @param enabled Gate the fetch on the card actually being expanded. A pool
 *   list renders one PoolCard per application — 61 of them on a real account —
 *   and every one of those cards mounts this hook while its body is still
 *   collapsed behind `{open && …}`. Fetching on mount therefore cost one
 *   request per row for content nobody had asked to see, and because the
 *   browser only opens ~6 connections per origin the tail of that queue was
 *   still draining 16s later, delaying every page the user clicked next.
 */
export function useCoverLetter(letterId: string | null, onError?: (msg: string) => void, enabled: boolean = true) {
  const router = useRouter();
  const [loaded, setLoaded]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText]       = useState("");
  const [saved, setSaved]     = useState("");
  const [saving, setSaving]   = useState(false);
  const loadStarted = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (!letterId || loaded || loadStarted.current) return;
    loadStarted.current = true;
    (async () => {
      setLoading(true);
      try {
        const res  = await fetch(`/api/applications/${letterId}`);
        const json = await res.json();
        if (res.ok) {
          const t = json.pass_3_final ?? "";
          setText(t);
          setSaved(t);
          setLoaded(true);
        } else {
          onError?.(json.error ?? "Could not load cover letter");
        }
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, [letterId, loaded, onError, enabled]);

  async function save() {
    if (saving || !letterId) return;
    setSaving(true);
    try {
      const res  = await fetch(`/api/applications/${letterId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pass_3_final: text }),
      });
      const json = await res.json();
      if (!res.ok) { onError?.(json.error ?? `Save failed (${res.status})`); return; }
      setSaved(text);
      router.refresh();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  const dirty = loaded && text !== saved;
  return { text, setText, dirty, saving, loading, save };
}
