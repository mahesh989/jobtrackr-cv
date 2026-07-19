"use client";

import { useRef, useTransition } from "react";
import { Button } from "@/components/ui";
import { copyProfile } from "@/lib/actions";

export function CopyProfileButton({
  profileId,
  compact = false,
}: {
  profileId: string;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const firedRef = useRef(false);

  function handleCopy() {
    if (firedRef.current) return;
    firedRef.current = true;
    startTransition(() => copyProfile(profileId));
  }

  if (compact) {
    return (
      <Button
        size="sm"
        isLoading={pending}
        onClick={handleCopy}
        className="text-text-3 hover:text-[var(--brand)] hover:border-[var(--brand)]/30"
        title="Duplicate profile"
      >
        {!pending && (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
        )}
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      isLoading={pending}
      onClick={handleCopy}
    >
      {!pending && (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
        </svg>
      )}
      {pending ? "Copying…" : "Duplicate"}
    </Button>
  );
}
