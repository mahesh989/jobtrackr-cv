"use client";

import { useState, useTransition } from "react";
import { markPoolDecision } from "@/lib/actions";

export function useContactEmail(initial: string | null, jobId: string, profileId: string, onError?: (msg: string) => void) {
  const [email, setEmail] = useState<string | null>(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial ?? "");
  const [, startTransition] = useTransition();

  function commit(value: string) {
    const trimmed = value.trim() || null;
    setEmail(trimmed);
    setEditing(false);
    startTransition(async () => {
      try {
        await markPoolDecision(jobId, profileId, trimmed ?? undefined);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Failed to save email address");
      }
    });
  }

  return { email, editing, setEditing, draft, setDraft, commit };
}
