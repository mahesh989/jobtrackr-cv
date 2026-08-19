"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Shell } from "./Shell";
import { TurnstileBox, type TurnstileBoxHandle } from "./TurnstileBox";
import { ErrorNotice, GOOGLE_SVG, Spinner, TURNSTILE_CONFIGURED } from "./brand";
import { Input } from "@/components/ui";
import { THIN_JD_HIDE_KEY } from "@/features/jobs/components/ThinJdModal";
import { sanitizeNextPath } from "@/lib/safeRedirect";

export function LoginForm() {
  const searchParams = useSearchParams();
  const confirmed = searchParams.get("confirmed");
  // ?next= — return the user to where they were headed (e.g. /pricing sends
  // signed-out visitors here before plan checkout). Same-origin paths only —
  // see safeRedirect.ts's header comment for why this can't be a manual
  // string-prefix check (B4-P2).
  const next = sanitizeNextPath(searchParams.get("next"));
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [captchaToken, setCaptchaToken]   = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileBoxHandle>(null);

  // Reaching the login page means a new sign-in is starting, so anything a
  // previous session chose to suppress "for this session" is reset here.
  // sessionStorage survives a sign-out within the same tab, so without this a
  // user who ticked "don't show me again", signed out and signed back in would
  // never see it again until they closed the tab.
  useEffect(() => {
    try { sessionStorage.removeItem(THIN_JD_HIDE_KEY); } catch { /* storage disabled */ }
  }, []);

  async function handleGoogleSignIn() {
    setGoogleLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/confirm`,
        // Force Google's account chooser every time. Without this Google
        // silently picks the only signed-in account and skips the picker,
        // which makes switching accounts impossible on shared machines.
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) { setError(error.message); setGoogleLoading(false); }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken: captchaToken ?? undefined },
    });
    // Turnstile tokens are single-use — clear + re-mint for any subsequent attempt.
    turnstileRef.current?.reset();
    setCaptchaToken(null);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    // Full page navigation, not router.push+refresh — the dashboard layout's
    // gates (entitlement, setup-wizard redirect) read fresh cookies/headers
    // per request; a client-side transition right after establishing a new
    // session could serve a stale RSC render and briefly show a blank
    // screen until a manual reload.
    window.location.href = next;
  }

  return (
    <Shell
      headline={
        <>
          Find your next role<br />
          <em style={{ fontStyle: "italic" }} className="text-[var(--brand)]">while you sleep.</em>
        </>
      }
      tagline="Australia's major sources scanned nightly, AI-ranked and ready in your feed every morning."
      switchPrompt="Need an account?"
      switchHref="/auth/signup"
      switchLabel="Sign up"
      trustLabels={["6 AU sources", "AI-ranked feed", "Visa signal", "3-day trial"]}
    >
      <h1
        style={{
          fontFamily: "var(--font-cv-serif)",
          fontSize: "clamp(1.75rem, 4vw, 2.25rem)",
          lineHeight: 1.12,
          letterSpacing: "-0.8px",
          marginBottom: 8,
        }}
      >
        Welcome back.
      </h1>
      <p className="text-text-2" style={{ fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
        Sign in with your email and password.
      </p>

      {confirmed && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-md mb-5 bg-success-subtle border border-success-border">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
          <p className="text-success" style={{ fontSize: 12.5 }}>Email confirmed — sign in to get started.</p>
        </div>
      )}

      {/* Google button */}
      <button onClick={handleGoogleSignIn} disabled={googleLoading || loading} className="w-full flex items-center justify-center gap-3 rounded-lg py-3 mb-5 transition-opacity hover:opacity-80 disabled:cursor-not-allowed cursor-pointer bg-surface border-[1.5px] border-border text-text" style={{ fontSize: 14, fontWeight: 500, opacity: googleLoading ? 0.7 : 1 }}>
        {googleLoading ? <Spinner size={18} /> : GOOGLE_SVG}
        Continue with Google
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-5">
        <div className="bg-border" style={{ flex: 1, height: 1 }} />
        <span className="text-text-3" style={{ fontSize: 12 }}>or sign in with email</span>
        <div className="bg-border" style={{ flex: 1, height: 1 }} />
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Input
          label="Email address"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoFocus
        />

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="password" className="text-label font-semibold text-text">
              Password
            </label>
            <Link
              href="/auth/forgot-password"
              className="underline-offset-2 hover:underline text-text-2"
              style={{ fontSize: 12 }}
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            label=""
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
          />
        </div>

        {error && <ErrorNotice message={error} />}

        <TurnstileBox ref={turnstileRef} onToken={setCaptchaToken} />

        <div style={{ marginTop: 28 }}>
          <button
            type="submit"
            disabled={loading || googleLoading || (TURNSTILE_CONFIGURED && !captchaToken)}
            className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 transition-opacity hover:opacity-90 disabled:cursor-not-allowed cursor-pointer bg-[var(--brand)] text-[var(--brand-fg)]"
            style={{
              fontSize: 14,
              fontWeight: 500,
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? (
              <>
                <Spinner />
                Signing in…
              </>
            ) : (
              <>
                Sign in
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8h10M9 4l4 4-4 4" />
                </svg>
              </>
            )}
          </button>
        </div>
      </form>

      <p className="text-center mt-6 text-text-3" style={{ fontSize: 12 }}>
        No account yet?{" "}
        <Link href="/auth/signup" className="text-[var(--brand)]" style={{ fontWeight: 500, textDecoration: "none" }}>
          Sign up free
        </Link>
      </p>
    </Shell>
  );
}
