"use client";

import { useTransition } from "react";
import { copyProfile } from "@/lib/actions";

export function CopyProfileButton({
  profileId,
  compact = false,
}: {
  profileId: string;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function handleCopy() {
    startTransition(() => copyProfile(profileId));
  }

  if (compact) {
    return (
      <button
        onClick={handleCopy}
        disabled={pending}
        className="gh-btn text-[12px] px-2 py-1 text-text-3 hover:text-[var(--brand)] hover:border-[var(--brand)]/30"
        title="Duplicate profile"
      >
        {pending ? (
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      disabled={pending}
      className="gh-btn text-[12px] px-2.5 py-1 flex items-center gap-1.5"
    >
      {pending ? (
        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
        </svg>
      )}
      {pending ? "Copying…" : "Duplicate"}
    </button>
  );
}
