"use client";

import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Shell } from "./Shell";
import { TurnstileBox, type TurnstileBoxHandle } from "./TurnstileBox";
import { ErrorNotice, GOOGLE_SVG, Spinner, TURNSTILE_CONFIGURED } from "./brand";
import { Input } from "@/components/ui";

export function LoginForm() {
  const searchParams = useSearchParams();
  const confirmed = searchParams.get("confirmed");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [captchaToken, setCaptchaToken]   = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileBoxHandle>(null);

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
    window.location.href = "/";
  }

  return (
    <Shell
      headline={
        <>
          Find your next role<br />
          <em style={{ fontStyle: "italic", color: "#0B7D74" }}>while you sleep.</em>
        </>
      }
      tagline="Australia's major sources scanned nightly, AI-ranked and ready in your feed every morning."
      switchPrompt="Need an account?"
      switchHref="/auth/signup"
      switchLabel="Sign up"
      trustLabels={["5 AU sources", "AI-ranked feed", "Visa signal", "3-day trial"]}
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
      <p style={{ color: "#475467", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
        Sign in with your email and password.
      </p>

      {confirmed && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-md mb-5"
          style={{ background: "rgba(11, 125, 116, 0.1)", border: "1px solid rgba(11, 125, 116, 0.25)" }}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "#0B7D74" }} />
          <p style={{ color: "#0B7D74", fontSize: 12.5 }}>Email confirmed — sign in to get started.</p>
        </div>
      )}

      {/* Google button */}
      <button onClick={handleGoogleSignIn} disabled={googleLoading || loading} className="w-full flex items-center justify-center gap-3 rounded-lg py-3 mb-5 transition-opacity hover:opacity-80 disabled:cursor-not-allowed cursor-pointer" style={{ background: "#FFFFFF", border: "1.5px solid #E2E8F0", fontSize: 14, fontWeight: 500, color: "#0E141B", opacity: googleLoading ? 0.7 : 1 }}>
        {googleLoading ? <Spinner size={18} /> : GOOGLE_SVG}
        Continue with Google
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-5">
        <div style={{ flex: 1, height: 1, background: "#E2E8F0" }} />
        <span style={{ fontSize: 12, color: "#667085" }}>or sign in with email</span>
        <div style={{ flex: 1, height: 1, background: "#E2E8F0" }} />
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
              className="underline-offset-2 hover:underline"
              style={{ fontSize: 12, color: "#475467" }}
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
            className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 transition-opacity hover:opacity-90 disabled:cursor-not-allowed cursor-pointer"
            style={{
              background: "#0B7D74",
              color: "#FFFFFF",
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

      <p className="text-center mt-6" style={{ fontSize: 12, color: "#667085" }}>
        No account yet?{" "}
        <Link href="/auth/signup" style={{ color: "#0B7D74", fontWeight: 500, textDecoration: "none" }}>
          Sign up free
        </Link>
      </p>
    </Shell>
  );
}
