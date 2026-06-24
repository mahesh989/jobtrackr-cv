"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { TurnstileBox, type TurnstileBoxHandle } from "@/components/auth/TurnstileBox";

const TURNSTILE_CONFIGURED = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const BRAND_PANEL_FEATURES = [
  "Australia's major sources scanned every night",
  "AI relevance scoring — best matches at the top",
  "Visa sponsorship signal on every listing",
  "Duplicates collapsed across all boards",
];

// eslint-disable-next-line @next/next/no-img-element
const LOGO_SVG = <img src="/logo.png" alt="" width={20} height={20} style={{ objectFit: "contain" }} />;

const GOOGLE_SVG = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

const inputStyle = {
  background: "#171C26",
  border: "1px solid #232A36",
  fontSize: 14,
  fontFamily: "var(--font-cv-sans), system-ui, sans-serif",
  color: "#EAEEF6",
} as React.CSSProperties;

export default function SignupPage() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [captchaToken, setCaptchaToken]   = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileBoxHandle>(null);

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
    setLoading(true);
    setError(null);
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
  }

  return (
    <div
      className="min-h-screen flex"
      style={{ fontFamily: "var(--font-cv-sans), system-ui, sans-serif", color: "#EAEEF6" }}
    >
      {/* ── Brand panel (desktop only) ── */}
      <aside
        className="hidden lg:flex flex-col justify-between w-[440px] shrink-0 px-12 py-10"
        style={{ background: "#0C1016", color: "#EAEEF6" }}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            {LOGO_SVG}
          </span>
          <span style={{ fontFamily: "var(--font-cv-serif)", fontSize: 18, letterSpacing: "-0.3px" }}>JobTrackr</span>
        </Link>

        <div>
          <h2 style={{ fontFamily: "var(--font-cv-serif)", fontSize: "clamp(1.75rem, 2.5vw, 2.25rem)", lineHeight: 1.15, letterSpacing: "-0.6px", color: "#EAEEF6", marginBottom: 12, fontWeight: 400 }}>
            Stop hunting.<br />
            <em style={{ fontStyle: "italic", color: "#19E3C8" }}>Start tracking.</em>
          </h2>
          <p style={{ color: "rgba(234,238,246,0.5)", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            Set up in 60 seconds. Your ranked feed will be ready before you wake up tomorrow.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {BRAND_PANEL_FEATURES.map((f) => (
              <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "rgba(234,238,246,0.7)", fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ width: 5, height: 5, background: "#19E3C8", borderRadius: "50%", flexShrink: 0, marginTop: 5 }} />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p style={{ fontSize: 11, color: "rgba(234,238,246,0.2)", letterSpacing: 0.3 }}>
          Built for Australian job seekers
        </p>
      </aside>

      {/* ── Form panel ── */}
      <div className="flex-1 flex flex-col" style={{ background: "#0A0D12" }}>
        {/* Mobile header */}
        <header className="flex lg:hidden items-center justify-between px-8 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#0C1016" }}>
              {LOGO_SVG}
            </span>
            <span style={{ fontFamily: "var(--font-cv-serif)", fontSize: 18, letterSpacing: "-0.3px" }}>JobTrackr</span>
          </Link>
          <Link href="/auth/login" className="text-[13px]" style={{ color: "#8B93A5" }}>
            Already have an account?{" "}
            <span style={{ color: "#19E3C8", fontWeight: 500 }}>Sign in</span>
          </Link>
        </header>

        {/* Desktop top-right link */}
        <div className="hidden lg:flex justify-end px-10 py-6">
          <Link href="/auth/login" className="text-[13px]" style={{ color: "#8B93A5" }}>
            Already have an account?{" "}
            <span style={{ color: "#19E3C8", fontWeight: 500 }}>Sign in</span>
          </Link>
        </div>

        {/* Form */}
        <main className="flex-1 flex items-center justify-center px-5 py-10">
          <div
            className="w-full max-w-md rounded-2xl px-10 py-12"
            style={{ background: "#11151C", border: "1px solid #232A36", boxShadow: "0 30px 60px -30px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.03)" }}
          >
            {submitted ? (
              /* ── Email sent state ── */
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
                  We sent a confirmation link to{" "}
                  <span style={{ color: "#EAEEF6", fontWeight: 500 }}>{email}</span>.
                  Click it to activate your account.
                </p>
                <button onClick={() => setSubmitted(false)} className="mt-6 text-[13px]" style={{ color: "#5B6478" }}>
                  Try a different email
                </button>
              </div>
            ) : (
              <>
                <div className="mb-6">
                  <h1 style={{ fontFamily: "var(--font-cv-serif)", fontSize: "clamp(1.75rem, 4vw, 2.25rem)", lineHeight: 1.12, letterSpacing: "-0.8px", marginBottom: 8 }}>
                    Create your account.
                  </h1>
                  <p style={{ color: "#8B93A5", fontSize: 14, lineHeight: 1.7, fontWeight: 300 }}>
                    Start your 3-day free trial — no commitment required.
                  </p>
                </div>

                {/* Google button */}
                <button
                  onClick={handleGoogleSignUp}
                  disabled={googleLoading || loading}
                  className="w-full flex items-center justify-center gap-3 rounded-lg py-3 mb-5 transition-opacity"
                  style={{ background: "#1A2030", border: "1.5px solid rgba(255,255,255,0.1)", fontSize: 14, fontWeight: 500, color: "#EAEEF6", opacity: googleLoading ? 0.7 : 1 }}
                >
                  {googleLoading ? (
                    <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <circle opacity="0.25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path opacity="0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : GOOGLE_SVG}
                  Continue with Google
                </button>

                {/* Divider */}
                <div className="flex items-center gap-3 mb-5">
                  <div style={{ flex: 1, height: 1, background: "#232A36" }} />
                  <span style={{ fontSize: 12, color: "#5B6478" }}>or sign up with email</span>
                  <div style={{ flex: 1, height: 1, background: "#232A36" }} />
                </div>

                {/* Email + password form */}
                <form onSubmit={handleEmailSignUp} className="space-y-4">
                  <div>
                    <label htmlFor="email" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>Email address</label>
                    <input
                      id="email" type="email" required
                      value={email} onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full px-4 py-3 rounded-lg outline-none"
                      style={inputStyle}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "#19E3C8"; e.currentTarget.style.background = "#11151C"; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = "#232A36"; e.currentTarget.style.background = "#171C26"; }}
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>Password</label>
                    <input
                      id="password" type="password" required minLength={8}
                      value={password} onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      className="w-full px-4 py-3 rounded-lg outline-none"
                      style={inputStyle}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "#19E3C8"; e.currentTarget.style.background = "#11151C"; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = "#232A36"; e.currentTarget.style.background = "#171C26"; }}
                    />
                  </div>

                  {error && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md" style={{ background: "#fff0ee", border: "1px solid rgba(207, 34, 46, 0.2)" }}>
                      <svg width="16" height="16" fill="#cf222e" viewBox="0 0 20 20" className="mt-0.5 shrink-0">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                      <p style={{ color: "#cf222e", fontSize: 12 }}>{error}</p>
                    </div>
                  )}

                  <TurnstileBox ref={turnstileRef} onToken={setCaptchaToken} />

                  <button
                    type="submit" disabled={loading || googleLoading || (TURNSTILE_CONFIGURED && !captchaToken)}
                    className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 mt-2 transition-opacity"
                    style={{ background: "#19E3C8", color: "#04231F", fontSize: 14, fontWeight: 500, opacity: loading ? 0.7 : 1 }}
                  >
                    {loading ? (
                      <>
                        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <circle opacity="0.25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path opacity="0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
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

                <p className="text-center mt-6" style={{ fontSize: 12, color: "#5B6478" }}>
                  Already have an account?{" "}
                  <Link href="/auth/login" style={{ color: "#19E3C8", fontWeight: 500, textDecoration: "none" }}>Sign in</Link>
                </p>
              </>
            )}
          </div>
        </main>

        <footer className="px-5 pb-10 pt-2">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mx-auto" style={{ maxWidth: 560 }}>
            {["5 AU sources", "AI-ranked feed", "Visa signal", "3-day free trial"].map((label) => (
              <li key={label} className="flex items-center gap-1.5" style={{ fontSize: 12, color: "#5B6478" }}>
                <span className="inline-block rounded-full" style={{ width: 4, height: 4, background: "#19E3C8" }} />
                {label}
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  );
}
