"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "./AuthShell";
import { TurnstileBox, type TurnstileBoxHandle } from "./TurnstileBox";
import { ErrorNotice, Spinner, TURNSTILE_CONFIGURED, inputStyle } from "./brand";

const RESEND_COOLDOWN_SECONDS = 60;

export function ForgotPasswordForm() {
  const [email, setEmail]     = useState("");
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileBoxHandle>(null);

  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading]   = useState(false);
  const [resendCaptchaToken, setResendCaptchaToken] = useState<string | null>(null);
  const resendTurnstileRef = useRef<TurnstileBoxHandle>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // Supabase's captcha protection (when enabled) applies to
  // resetPasswordForEmail the same as signUp/signInWithPassword — omitting
  // captchaToken here fails with "captcha protection: request disallowed".
  async function sendResetLink(token: string | null) {
    const supabase = createClient();
    return supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/confirm`,
      captchaToken: token ?? undefined,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await sendResetLink(captchaToken);
    turnstileRef.current?.reset();
    setCaptchaToken(null);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setSent(true);
    setLoading(false);
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  }

  async function handleResend() {
    if (resendCooldown > 0 || resendLoading) return;
    setResendLoading(true);
    setError(null);
    const { error } = await sendResetLink(resendCaptchaToken);
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
    setSent(false);
    setEmail("");
    setError(null);
    setCaptchaToken(null);
    setResendCaptchaToken(null);
    setResendCooldown(0);
    turnstileRef.current?.reset();
    resendTurnstileRef.current?.reset();
  }

  return (
    <AuthShell
      headline={
        <>
          Forgot your<br />
          <em style={{ fontStyle: "italic", color: "#19E3C8" }}>password?</em>
        </>
      }
      tagline="No worries — we'll email you a link to set a new one."
      switchPrompt="Remembered it?"
      switchHref="/auth/login"
      switchLabel="Sign in"
      trustLabels={["5 AU sources", "AI-ranked feed", "Visa signal", "3-day trial"]}
    >
      {sent ? (
        <div className="text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(25, 227, 200, 0.12)", border: "1px solid rgba(25, 227, 200, 0.2)" }}>
            <svg width="22" height="22" fill="none" stroke="#19E3C8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="mb-2" style={{ fontFamily: "var(--font-cv-serif)", fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.5px" }}>
            Check your inbox
          </h1>
          <p style={{ color: "#8B93A5", fontSize: 14, lineHeight: 1.65, fontWeight: 300 }}>
            If an account exists for{" "}
            <span style={{ color: "#EAEEF6", fontWeight: 500 }}>{email}</span>,
            we sent a link to reset your password.
          </p>
          {error && <div className="mt-4"><ErrorNotice message={error} /></div>}

          <div className="mt-5">
            {resendCooldown > 0 ? (
              <p style={{ fontSize: 12, color: "#5B6478" }}>
                Didn&apos;t get it? Resend in {resendCooldown}s
              </p>
            ) : (
              <>
                {TURNSTILE_CONFIGURED && (
                  <div className="mb-2">
                    <TurnstileBox ref={resendTurnstileRef} onToken={setResendCaptchaToken} />
                  </div>
                )}
                <button
                  onClick={handleResend}
                  disabled={resendLoading || (TURNSTILE_CONFIGURED && !resendCaptchaToken)}
                  className="text-[13px] underline underline-offset-2 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: "#19E3C8" }}
                >
                  {resendLoading ? "Resending…" : "Resend reset link"}
                </button>
              </>
            )}
          </div>

          <button
            onClick={handleTryDifferentEmail}
            className="mt-4 text-[13px] underline underline-offset-2 cursor-pointer transition-colors"
            style={{ color: "#8B93A5" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#19E3C8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#8B93A5"; }}
          >
            Try a different email
          </button>
        </div>
      ) : (
        <>
          <h1
            style={{
              fontFamily: "var(--font-cv-serif)",
              fontSize: "clamp(1.75rem, 4vw, 2.25rem)",
              lineHeight: 1.12,
              letterSpacing: "-0.8px",
              marginBottom: 8,
            }}
          >
            Reset your password.
          </h1>
          <p style={{ color: "#8B93A5", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            Enter the email on your account and we&apos;ll send you a reset link.
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="email" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoFocus
                className="w-full px-4 py-3 rounded-lg outline-none transition-colors"
                style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = "#19E3C8"; e.currentTarget.style.background = "#11151C"; }}
                onBlur={(e)  => { e.currentTarget.style.borderColor = "#232A36"; e.currentTarget.style.background = "#171C26"; }}
              />
            </div>

            {error && <ErrorNotice message={error} />}

            <TurnstileBox ref={turnstileRef} onToken={setCaptchaToken} />

            <button
              type="submit"
              disabled={loading || (TURNSTILE_CONFIGURED && !captchaToken)}
              className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 transition-opacity hover:opacity-90 disabled:cursor-not-allowed cursor-pointer"
              style={{
                background: "#19E3C8",
                color: "#04231F",
                fontSize: 14,
                fontWeight: 500,
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                "Send reset link"
              )}
            </button>
          </form>

          <p className="text-center mt-6" style={{ fontSize: 12, color: "#5B6478" }}>
            <Link href="/auth/login" style={{ color: "#19E3C8", fontWeight: 500, textDecoration: "none" }}>
              ← Back to sign in
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
