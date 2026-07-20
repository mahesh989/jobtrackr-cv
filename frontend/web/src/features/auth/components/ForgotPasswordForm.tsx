"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Shell } from "./Shell";
import { TurnstileBox, type TurnstileBoxHandle } from "./TurnstileBox";
import { ErrorNotice, Spinner, TURNSTILE_CONFIGURED } from "./brand";
import { Input } from "@/components/ui";

const RESEND_COOLDOWN_SECONDS = 60;

export function ForgotPasswordForm() {
  const [email, setEmail]     = useState("");
  const [sent, setSent]       = useState(false);
  // Set only when the account exists and has no password identity (Google-
  // only signup) — distinct from `sent` because there's genuinely nothing to
  // wait for an inbox for in this case.
  const [ssoOnly, setSsoOnly] = useState(false);
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

  async function sendResetLink(token: string | null): Promise<{ ssoOnly: boolean; error: string | null }> {
    // Check first (server-side, DB-only — no GoTrue call, safe to run here).
    const checkRes = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const checkData = await checkRes.json();
    if (!checkRes.ok) return { ssoOnly: false, error: checkData.error ?? "Something went wrong." };
    if (checkData.ssoOnly) return { ssoOnly: true, error: null };

    // The actual send MUST run client-side: Supabase's recovery flow is
    // PKCE-based, and the code_verifier it generates has to land in the
    // same browser that will later exchange the emailed link's `code` —
    // calling this from our server (as a previous version did) stored the
    // verifier in a throwaway server request context instead, so every
    // link failed exchange later regardless of how fast the user clicked.
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/confirm`,
      captchaToken: token ?? undefined,
    });
    if (error) return { ssoOnly: false, error: error.message };
    return { ssoOnly: false, error: null };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await sendResetLink(captchaToken);
    turnstileRef.current?.reset();
    setCaptchaToken(null);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.ssoOnly) {
      setSsoOnly(true);
      return;
    }
    setSent(true);
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  }

  async function handleResend() {
    if (resendCooldown > 0 || resendLoading) return;
    setResendLoading(true);
    setError(null);
    const result = await sendResetLink(resendCaptchaToken);
    resendTurnstileRef.current?.reset();
    setResendCaptchaToken(null);
    setResendLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  }

  function handleTryDifferentEmail() {
    setSent(false);
    setSsoOnly(false);
    setEmail("");
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
          Forgot your<br />
          <em style={{ fontStyle: "italic", color: "#0B7D74" }}>password?</em>
        </>
      }
      tagline="No worries — we'll email you a link to set a new one."
      switchPrompt="Remembered it?"
      switchHref="/auth/login"
      switchLabel="Sign in"
      trustLabels={["5 AU sources", "AI-ranked feed", "Visa signal", "3-day trial"]}
    >
      {ssoOnly ? (
        <div className="text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "#EEF2F7", border: "1px solid #E2E8F0" }}>
            <svg width="22" height="22" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
              <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
            </svg>
          </div>
          <h1 className="mb-2" style={{ fontFamily: "var(--font-cv-serif)", fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.5px" }}>
            This account uses Google
          </h1>
          <p style={{ color: "#475467", fontSize: 14, lineHeight: 1.65, fontWeight: 300 }}>
            <span style={{ color: "#0E141B", fontWeight: 500 }}>{email}</span>{" "}
            signs in with Google — there&apos;s no password to reset. Use &quot;Continue with Google&quot; on the sign-in page instead.
          </p>
          <Link
            href="/auth/login"
            className="mt-6 inline-block text-[13px] font-semibold rounded-lg px-5 py-2.5 transition-opacity hover:opacity-90"
            style={{ background: "#0B7D74", color: "#FFFFFF" }}
          >
            Go to sign in
          </Link>
        </div>
      ) : sent ? (
        <div className="text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(11, 125, 116, 0.12)", border: "1px solid rgba(11, 125, 116, 0.2)" }}>
            <svg width="22" height="22" fill="none" stroke="#0B7D74" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="mb-2" style={{ fontFamily: "var(--font-cv-serif)", fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.5px" }}>
            Check your inbox
          </h1>
          <p style={{ color: "#475467", fontSize: 14, lineHeight: 1.65, fontWeight: 300 }}>
            If an account exists for{" "}
            <span style={{ color: "#0E141B", fontWeight: 500 }}>{email}</span>,
            we sent a link to reset your password.
          </p>
          {error && <div className="mt-4"><ErrorNotice message={error} /></div>}

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
                <button onClick={handleResend} disabled={resendLoading || (TURNSTILE_CONFIGURED && !resendCaptchaToken)} className="text-[13px] underline underline-offset-2 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ color: "#0B7D74" }}>
                  {resendLoading ? "Resending…" : "Resend reset link"}
                </button>
              </>
            )}
          </div>

          <button onClick={handleTryDifferentEmail} className="mt-4 text-[13px] underline underline-offset-2 cursor-pointer transition-colors" style={{ color: "#475467" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#0B7D74"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "#475467"; }}>
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
          <p style={{ color: "#475467", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            Enter the email on your account and we&apos;ll send you a reset link.
          </p>

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

            {error && <ErrorNotice message={error} />}

            <TurnstileBox ref={turnstileRef} onToken={setCaptchaToken} />

            <button
              type="submit"
              disabled={loading || (TURNSTILE_CONFIGURED && !captchaToken)}
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
                  Sending…
                </>
              ) : (
                "Send reset link"
              )}
            </button>
          </form>

          <p className="text-center mt-6" style={{ fontSize: 12, color: "#667085" }}>
            <Link href="/auth/login" style={{ color: "#0B7D74", fontWeight: 500, textDecoration: "none" }}>
              ← Back to sign in
            </Link>
          </p>
        </>
      )}
    </Shell>
  );
}
