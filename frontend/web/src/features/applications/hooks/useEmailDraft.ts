"use client";

import { useEffect, useRef, useState } from "react";

export function useEmailDraft(letterId: string | null, onError?: (msg: string) => void) {
  const [loaded, setLoaded]       = useState(false);
  const [loading, setLoading]     = useState(false);
  const [subject, setSubject]     = useState("");
  const [subjectSaved, setSubjectSaved] = useState("");
  const [body, setBody]           = useState("");
  const [bodySaved, setBodySaved] = useState("");
  const [saving, setSaving]       = useState(false);
  const [voiceRewritten, setVoiceRewritten] = useState(false);
  const loadStarted = useRef(false);

  useEffect(() => {
    if (!letterId || loaded || loadStarted.current) return;
    loadStarted.current = true;
    (async () => {
      setLoading(true);
      try {
        const res  = await fetch(`/api/applications/${letterId}/email-draft`);
        const json = await res.json();
        if (res.ok) {
          setSubject(json.subject ?? "");
          setSubjectSaved(json.subject ?? "");
          setBody(json.body ?? "");
          setBodySaved(json.body ?? "");
          setVoiceRewritten(!!json.voice_rewritten);
          setLoaded(true);
        } else {
          onError?.(json.error ?? "Could not load email draft");
        }
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, [letterId, loaded, onError]);

  async function save() {
    if (saving || !letterId) return;
    if (!subject.trim()) { onError?.("Subject can't be empty"); return; }
    if (!body.trim())    { onError?.("Body can't be empty"); return; }
    setSaving(true);
    try {
      const res  = await fetch(`/api/applications/${letterId}/review`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject: subject.trim(), body }),
      });
      const json = await res.json();
      if (!res.ok) { onError?.(json.error ?? `Save failed (${res.status})`); return; }
      setSubjectSaved(subject);
      setBodySaved(body);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  const dirty = loaded && (subject !== subjectSaved || body !== bodySaved);
  return { loaded, subject, setSubject, body, setBody, dirty, saving, loading, voiceRewritten, save };
}
