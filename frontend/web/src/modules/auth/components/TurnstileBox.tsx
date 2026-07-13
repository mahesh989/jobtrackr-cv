"use client";

/**
 * Cloudflare Turnstile widget for the login / signup forms.
 *
 * Wraps @marsidev/react-turnstile and exposes a `reset()` via ref so the parent
 * can clear the widget after every auth attempt — Turnstile tokens are
 * single-use (and expire after 300s), so a token must be re-minted per submit or
 * Supabase / siteverify returns "timeout-or-duplicate".
 *
 * If NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset (e.g. before keys are provisioned)
 * the component renders nothing and reports a token immediately, so the form
 * stays usable in environments where the gate isn't configured yet.
 */

import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { forwardRef, useImperativeHandle, useRef } from "react";

export interface TurnstileBoxHandle {
  reset: () => void;
}

interface Props {
  /** Called with a fresh token when the challenge is solved (null when it expires / errors). */
  onToken: (token: string | null) => void;
}

export const TurnstileBox = forwardRef<TurnstileBoxHandle, Props>(function TurnstileBox(
  { onToken },
  ref,
) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const widgetRef = useRef<TurnstileInstance | null>(null);

  useImperativeHandle(ref, () => ({
    reset: () => widgetRef.current?.reset(),
  }));

  // Not configured → don't block the form. Layer-1 (Supabase) enforcement still
  // applies server-side once the key+secret are set; this only affects local/preview.
  if (!siteKey) return null;

  return (
    <div className="flex justify-center my-4">
      <Turnstile
        ref={widgetRef}
        siteKey={siteKey}
        options={{ theme: "light", size: "flexible" }}
        onSuccess={(token) => onToken(token)}
        onExpire={() => onToken(null)}
        onError={() => onToken(null)}
      />
    </div>
  );
});
