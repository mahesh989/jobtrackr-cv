"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

const BRAND_PANEL_FEATURES = [
  "21+ Australian sources scanned every night",
  "AI relevance scoring — best matches at the top",
  "Visa sponsorship signal on every listing",
  "Duplicates collapsed across all boards",
];

const LOGO_SVG = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="3" />
    <path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.2 3.2l1.4 1.4M13.4 13.4l1.4 1.4M3.2 14.8l1.4-1.4M13.4 4.6l1.4-1.4" />
  </svg>
);

export default function SignupPage() {
  const [email, setEmail]           = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const validateRes = await fetch("/api/auth/validate-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode.trim().toUpperCase() }),
    });

    if (!validateRes.ok) {
      const { error: msg } = await validateRes.json();
      setError(msg ?? "Invalid invite code");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm?invite=${encodeURIComponent(inviteCode.trim().toUpperCase())}`,
        shouldCreateUser: true,
      },
    });

    if (authError) { setError(authError.message); setLoading(false); return; }
    setSubmitted(true);
  }

  return (
    <div
      className="min-h-screen flex"
      style={{ fontFamily: "var(--font-marketing), system-ui, sans-serif", color: "#0f0f0e" }}
    >
      {/* ── Brand panel (desktop only) ── */}
      <aside
        className="hidden lg:flex flex-col justify-between w-[440px] shrink-0 px-12 py-10"
        style={{ background: "#0f0f0e", color: "#f5f3ef" }}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}
            aria-hidden="true"
          >
            {LOGO_SVG}
          </span>
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 18, letterSpacing: "-0.3px" }}>JobTrackr</span>
        </Link>

        <div>
          <h2
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(1.75rem, 2.5vw, 2.25rem)",
              lineHeight: 1.15,
              letterSpacing: "-0.6px",
              color: "#f5f3ef",
              marginBottom: 12,
              fontWeight: 400,
            }}
          >
            Stop hunting.<br />
            <em style={{ fontStyle: "italic", color: "#2d9e6e" }}>Start tracking.</em>
          </h2>
          <p style={{ color: "rgba(245,243,239,0.5)", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            Set up in 60 seconds. Your ranked feed will be ready before you wake up tomorrow.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {BRAND_PANEL_FEATURES.map((f) => (
              <li
                key={f}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  padding: "10px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  color: "rgba(245,243,239,0.7)",
                  fontSize: 13, lineHeight: 1.5,
                }}
              >
                <span
                  style={{ width: 5, height: 5, background: "#2d9e6e", borderRadius: "50%", flexShrink: 0, marginTop: 5 }}
                />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p style={{ fontSize: 11, color: "rgba(245,243,239,0.25)", letterSpacing: 0.3 }}>
          Invite-only beta · Built for Australian job seekers
        </p>
      </aside>

      {/* ── Form panel ── */}
      <div className="flex-1 flex flex-col" style={{ background: "#faf9f7" }}>
        {/* Mobile header */}
        <header className="flex lg:hidden items-center justify-between px-8 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "#0f0f0e" }}
              aria-hidden="true"
            >
              {LOGO_SVG}
            </span>
            <span style={{ fontFamily: "var(--font-serif)", fontSize: 18, letterSpacing: "-0.3px" }}>JobTrackr</span>
          </Link>
          <Link href="/auth/login" className="text-[13px]" style={{ color: "#6b6b68" }}>
            Already have an account?{" "}
            <span style={{ color: "#1a6b4a", fontWeight: 500 }}>Sign in</span>
          </Link>
        </header>

        {/* Desktop top-right link */}
        <div className="hidden lg:flex justify-end px-10 py-6">
          <Link href="/auth/login" className="text-[13px]" style={{ color: "#6b6b68" }}>
            Already have an account?{" "}
            <span style={{ color: "#1a6b4a", fontWeight: 500 }}>Sign in</span>
          </Link>
        </div>

        {/* Form */}
        <main className="flex-1 flex items-center justify-center px-5 py-10">
          <div
            className="w-full max-w-md rounded-2xl px-10 py-12"
            style={{
              background: "#ffffff",
              border: "1px solid rgba(15, 15, 14, 0.08)",
              boxShadow: "0 30px 60px -30px rgba(15, 15, 14, 0.12), 0 1px 0 rgba(15, 15, 14, 0.02)",
            }}
          >
            {submitted ? (
              <div className="text-center">
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5"
                  style={{ background: "#e8f4ef", border: "1px solid rgba(26, 107, 74, 0.2)" }}
                >
                  <svg width="22" height="22" fill="none" stroke="#1a6b4a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <h1
                  className="mb-2"
                  style={{ fontFamily: "var(--font-serif)", fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.5px" }}
                >
                  Check your inbox
                </h1>
                <p style={{ color: "#6b6b68", fontSize: 14, lineHeight: 1.65, fontWeight: 300 }}>
                  We sent a confirmation link to{" "}
                  <span style={{ color: "#0f0f0e", fontWeight: 500 }}>{email}</span>.
                  Click it to activate your account.
                </p>
                <button
                  onClick={() => setSubmitted(false)}
                  className="mt-6 text-[13px]"
                  style={{ color: "#9a9a96" }}
                >
                  Try a different email
                </button>
              </div>
            ) : (
              <>
                <div className="mb-6">
                  <div
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full mb-4"
                    style={{ background: "#e8f4ef", border: "1px solid rgba(26,107,74,0.2)", fontSize: 12, color: "#1a6b4a", fontWeight: 500 }}
                  >
                    <span style={{ width: 5, height: 5, background: "#2d9e6e", borderRadius: "50%", display: "inline-block" }} />
                    Invite-only beta
                  </div>
                  <h1
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontSize: "clamp(1.75rem, 4vw, 2.25rem)",
                      lineHeight: 1.12,
                      letterSpacing: "-0.8px",
                      marginBottom: 8,
                    }}
                  >
                    Create your account.
                  </h1>
                  <p style={{ color: "#6b6b68", fontSize: 14, lineHeight: 1.7, fontWeight: 300 }}>
                    Enter your invite code and email to get started. You&apos;ll be set up in 60 seconds.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <label htmlFor="invite" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>
                      Invite code
                    </label>
                    <input
                      id="invite"
                      type="text"
                      required
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                      placeholder="JT-XXXXXXXX"
                      autoFocus
                      className="w-full px-4 py-3 rounded-lg outline-none uppercase"
                      style={{
                        background: "#faf9f7",
                        border: "1px solid rgba(15, 15, 14, 0.12)",
                        fontSize: 14,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        letterSpacing: 2,
                        color: "#0f0f0e",
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "#1a6b4a"; e.currentTarget.style.background = "#ffffff"; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = "rgba(15, 15, 14, 0.12)"; e.currentTarget.style.background = "#faf9f7"; }}
                    />
                  </div>

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
                      className="w-full px-4 py-3 rounded-lg outline-none"
                      style={{
                        background: "#faf9f7",
                        border: "1px solid rgba(15, 15, 14, 0.12)",
                        fontSize: 14,
                        fontFamily: "var(--font-marketing), system-ui, sans-serif",
                        color: "#0f0f0e",
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "#1a6b4a"; e.currentTarget.style.background = "#ffffff"; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = "rgba(15, 15, 14, 0.12)"; e.currentTarget.style.background = "#faf9f7"; }}
                    />
                  </div>

                  {error && (
                    <div
                      className="flex items-start gap-2.5 px-3 py-2.5 rounded-md"
                      style={{ background: "#fff0ee", border: "1px solid rgba(207, 34, 46, 0.2)" }}
                    >
                      <svg width="16" height="16" fill="#cf222e" viewBox="0 0 20 20" className="mt-0.5 shrink-0">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                      <p style={{ color: "#cf222e", fontSize: 12 }}>{error}</p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 mt-2"
                    style={{
                      background: "#0f0f0e",
                      color: "#faf9f7",
                      fontSize: 14,
                      fontWeight: 500,
                      opacity: loading ? 0.7 : 1,
                    }}
                  >
                    {loading ? (
                      <>
                        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <circle opacity="0.25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path opacity="0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Checking…
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

                <p className="text-center mt-6" style={{ fontSize: 12, color: "#9a9a96" }}>
                  Already have an account?{" "}
                  <Link href="/auth/login" style={{ color: "#1a6b4a", fontWeight: 500, textDecoration: "none" }}>
                    Sign in
                  </Link>
                </p>
              </>
            )}
          </div>
        </main>

        {/* Trust strip */}
        <footer className="px-5 pb-10 pt-2">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mx-auto" style={{ maxWidth: 560 }}>
            {["21+ AU sources", "AI-ranked feed", "Visa signal", "Free plan"].map((label) => (
              <li key={label} className="flex items-center gap-1.5" style={{ fontSize: 12, color: "#9a9a96" }}>
                <span className="inline-block rounded-full" style={{ width: 4, height: 4, background: "#1a6b4a" }} />
                {label}
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  );
}
