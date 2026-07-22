"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Shell } from "./Shell";
import { TurnstileBox, type TurnstileBoxHandle } from "./TurnstileBox";
import { PasswordRequirements, passwordMeetsAllRules } from "./PasswordRequirements";
import { ErrorNotice, GOOGLE_SVG, Spinner, TURNSTILE_CONFIGURED } from "./brand";
import { Input } from "@/components/ui";

const RESEND_COOLDOWN_SECONDS = 60;

export function SignupForm() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [captchaToken, setCaptchaToken]   = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileBoxHandle>(null);

  // Resend flow (shown in the "Check your inbox" state).
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading]   = useState(false);
  const [resendCaptchaToken, setResendCaptchaToken] = useState<string | null>(null);
  const resendTurnstileRef = useRef<TurnstileBoxHandle>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function handleGoogleSignUp() {
    setGoogleLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/confirm`,
        // Force Google's account chooser every time.
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setError(error.message);
      setGoogleLoading(false);
    }
    // On success browser redirects to Google — no further action needed.
  }

  async function handleEmailSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!passwordMeetsAllRules(password)) {
      setError("Your password doesn't meet all the requirements below yet.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match — please re-enter them.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
        captchaToken: captchaToken ?? undefined,
      },
    });
    // Turnstile tokens are single-use — clear + re-mint for any subsequent attempt.
    turnstileRef.current?.reset();
    setCaptchaToken(null);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setSubmitted(true);
    setLoading(false);
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  }

  async function handleResend() {
    if (resendCooldown > 0 || resendLoading) return;
    setResendLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
        captchaToken: resendCaptchaToken ?? undefined,
      },
    });
    resendTurnstileRef.current?.reset();
    setResendCaptchaToken(null);
    setResendLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  }

  function handleTryDifferentEmail() {
    setSubmitted(false);
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setError(null);
    setCaptchaToken(null);
    setResendCaptchaToken(null);
    setResendCooldown(0);
    turnstileRef.current?.reset();
    resendTurnstileRef.current?.reset();
  }

  return (
    <Shell
      headline={
        <>
          Stop hunting.<br />
          <em style={{ fontStyle: "italic", color: "#3B82F6" }}>Start tracking.</em>
        </>
      }
      tagline="Set up in 60 seconds. Your ranked feed will be ready before you wake up tomorrow."
      switchPrompt="Already have an account?"
      switchHref="/auth/login"
      switchLabel="Sign in"
      trustLabels={["5 AU sources", "AI-ranked feed", "Visa signal", "3-day free trial"]}
    >
      {submitted ? (
        /* ── Email sent state ── */
        <div className="text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(11, 125, 116, 0.12)", border: "1px solid rgba(11, 125, 116, 0.2)" }}>
            <svg width="22" height="22" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="mb-2" style={{ fontFamily: "var(--font-cv-serif)", fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.5px" }}>
            Check your inbox
          </h1>
          <p style={{ color: "#475569", fontSize: 14, lineHeight: 1.65, fontWeight: 300 }}>
            We sent a confirmation link to{" "}
            <span style={{ color: "#0F172A", fontWeight: 500 }}>{email}</span>.
            Click it to activate your account.
          </p>

          {error && <div className="mt-4"><ErrorNotice message={error} /></div>}

          {/* Resend */}
          <div className="mt-5">
            {resendCooldown > 0 ? (
              <p style={{ fontSize: 12, color: "#667085" }}>
                Didn&apos;t get it? Resend in {resendCooldown}s
              </p>
            ) : (
              <>
                {TURNSTILE_CONFIGURED && (
                  <div className="mb-2">
                    <TurnstileBox ref={resendTurnstileRef} onToken={setResendCaptchaToken} />
                  </div>
                )}
                <button onClick={handleResend} disabled={resendLoading || (TURNSTILE_CONFIGURED && !resendCaptchaToken)} className="text-body underline underline-offset-2 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ color: "#3B82F6" }}>
                  {resendLoading ? "Resending…" : "Resend confirmation email"}
                </button>
              </>
            )}
          </div>

          <button onClick={handleTryDifferentEmail} className="mt-4 text-body underline underline-offset-2 cursor-pointer transition-colors" style={{ color: "#475569" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#3B82F6"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#475569"; }}>
            Try a different email
          </button>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <h1 style={{ fontFamily: "var(--font-cv-serif)", fontSize: "clamp(1.75rem, 4vw, 2.25rem)", lineHeight: 1.12, letterSpacing: "-0.8px", marginBottom: 8 }}>
              Create your account.
            </h1>
            <p style={{ color: "#475569", fontSize: 14, lineHeight: 1.7, fontWeight: 300 }}>
              Start your 3-day free trial — no commitment required.
            </p>
          </div>

          {/* Google button */}
          <button onClick={handleGoogleSignUp} disabled={googleLoading || loading} className="w-full flex items-center justify-center gap-3 rounded-lg py-3 mb-5 transition-opacity hover:opacity-80 disabled:cursor-not-allowed cursor-pointer" style={{ background: "#FFFFFF", border: "1.5px solid #E2E8F0", fontSize: 14, fontWeight: 500, color: "#0F172A", opacity: googleLoading ? 0.7 : 1 }}>
            {googleLoading ? <Spinner size={18} /> : GOOGLE_SVG}
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-5">
            <div style={{ flex: 1, height: 1, background: "#E2E8F0" }} />
            <span style={{ fontSize: 12, color: "#667085" }}>or sign up with email</span>
            <div style={{ flex: 1, height: 1, background: "#E2E8F0" }} />
          </div>

          {/* Email + password form */}
          <form onSubmit={handleEmailSignUp} className="space-y-4">
            <Input
              label="Email address"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <div>
              <Input
                label="Password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create a password"
              />
              <PasswordRequirements password={password} />
            </div>
            <Input
              label="Confirm password"
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your password"
              error={confirmPassword.length > 0 && confirmPassword !== password ? "Passwords do not match." : undefined}
            />

            {error && <ErrorNotice message={error} />}

            <TurnstileBox ref={turnstileRef} onToken={setCaptchaToken} />

            <button
              type="submit"
              disabled={
                loading || googleLoading ||
                (TURNSTILE_CONFIGURED && !captchaToken) ||
                !passwordMeetsAllRules(password) ||
                password !== confirmPassword
              }
              className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 mt-2 transition-opacity hover:opacity-90 disabled:cursor-not-allowed cursor-pointer"
              style={{ background: "#3B82F6", color: "#FFFFFF", fontSize: 14, fontWeight: 500, opacity: loading ? 0.7 : 1 }}
            >
              {loading ? (
                <>
                  <Spinner />
                  Creating account…
                </>
              ) : (
                <>
                  Create account
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8h10M9 4l4 4-4 4" />
                  </svg>
                </>
              )}
            </button>
          </form>

          <p className="text-center mt-6" style={{ fontSize: 12, color: "#667085" }}>
            Already have an account?{" "}
            <Link href="/auth/login" style={{ color: "#3B82F6", fontWeight: 500, textDecoration: "none" }}>Sign in</Link>
          </p>
        </>
      )}
    </Shell>
  );
}
