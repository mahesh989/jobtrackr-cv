"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";

const GOOGLE_SVG = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

const BRAND_PANEL_FEATURES = [
  "Australia's major sources scanned every night",
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

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

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

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div
      className="min-h-screen flex"
      style={{ fontFamily: "var(--font-cv-sans), system-ui, sans-serif", color: "#0A1530" }}
    >
      {/* ── Brand panel (desktop only) ── */}
      <aside
        className="hidden lg:flex flex-col justify-between w-[440px] shrink-0 px-12 py-10"
        style={{ background: "#241A5C", color: "#F4EEFB" }}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)" }}
            aria-hidden="true"
          >
            {LOGO_SVG}
          </span>
          <span style={{ fontFamily: "var(--font-cv-serif)", fontSize: 18, letterSpacing: "-0.3px" }}>JobTrackr</span>
        </Link>

        <div>
          <h2
            style={{
              fontFamily: "var(--font-cv-serif)",
              fontSize: "clamp(1.75rem, 2.5vw, 2.25rem)",
              lineHeight: 1.15,
              letterSpacing: "-0.6px",
              color: "#F4EEFB",
              marginBottom: 12,
              fontWeight: 400,
            }}
          >
            Find your next role<br />
            <em style={{ fontStyle: "italic", color: "#8250DF" }}>while you sleep.</em>
          </h2>
          <p style={{ color: "rgba(244,238,251,0.5)", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            Australia's major sources scanned nightly, AI-ranked and ready in your feed every morning.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {BRAND_PANEL_FEATURES.map((f) => (
              <li
                key={f}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  padding: "10px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  color: "rgba(244,238,251,0.7)",
                  fontSize: 13, lineHeight: 1.5,
                }}
              >
                <span
                  style={{ width: 5, height: 5, background: "#8250DF", borderRadius: "50%", flexShrink: 0, marginTop: 5 }}
                />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p style={{ fontSize: 11, color: "rgba(244,238,251,0.25)", letterSpacing: 0.3 }}>
          Built for Australian job seekers
        </p>
      </aside>

      {/* ── Form panel ── */}
      <div className="flex-1 flex flex-col" style={{ background: "#ECE7FB" }}>
        {/* Mobile header */}
        <header className="flex lg:hidden items-center justify-between px-8 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "#241A5C" }}
              aria-hidden="true"
            >
              {LOGO_SVG}
            </span>
            <span style={{ fontFamily: "var(--font-cv-serif)", fontSize: 18, letterSpacing: "-0.3px" }}>JobTrackr</span>
          </Link>
          <Link href="/auth/signup" className="text-[13px]" style={{ color: "#6B6A8C" }}>
            Need an account?{" "}
            <span style={{ color: "#5645D4", fontWeight: 500 }}>Sign up</span>
          </Link>
        </header>

        {/* Desktop top-right link */}
        <div className="hidden lg:flex justify-end px-10 py-6">
          <Link href="/auth/signup" className="text-[13px]" style={{ color: "#6B6A8C" }}>
            Need an account?{" "}
            <span style={{ color: "#5645D4", fontWeight: 500 }}>Sign up</span>
          </Link>
        </div>

        {/* Form */}
        <main className="flex-1 flex items-center justify-center px-5 py-10">
          <div
            className="w-full max-w-md rounded-2xl px-10 py-12"
            style={{
              background: "#ffffff",
              border: "1px solid rgba(10, 21, 48, 0.08)",
              boxShadow: "0 30px 60px -30px rgba(10, 21, 48, 0.12), 0 1px 0 rgba(10, 21, 48, 0.02)",
            }}
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
                <p style={{ color: "#6B6A8C", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
                  Sign in with your email and password.
                </p>

                {/* Google button */}
                <button
                  onClick={handleGoogleSignIn}
                  disabled={googleLoading || loading}
                  className="w-full flex items-center justify-center gap-3 rounded-lg py-3 mb-5 transition-opacity"
                  style={{ background: "#ffffff", border: "1.5px solid rgba(10,21,48,0.15)", fontSize: 14, fontWeight: 500, color: "#0A1530", opacity: googleLoading ? 0.7 : 1 }}
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
                  <div style={{ flex: 1, height: 1, background: "rgba(10,21,48,0.08)" }} />
                  <span style={{ fontSize: 12, color: "#938FB8" }}>or sign in with email</span>
                  <div style={{ flex: 1, height: 1, background: "rgba(10,21,48,0.08)" }} />
                </div>

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
                      style={{
                        background: "#F4EEFB",
                        border: "1px solid rgba(10, 21, 48, 0.12)",
                        fontSize: 14,
                        fontFamily: "var(--font-cv-sans), system-ui, sans-serif",
                        color: "#0A1530",
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "#5645D4"; e.currentTarget.style.background = "#ffffff"; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = "rgba(10, 21, 48, 0.12)"; e.currentTarget.style.background = "#F4EEFB"; }}
                    />
                  </div>

                  <div>
                    <label htmlFor="password" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>
                      Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Your password"
                      className="w-full px-4 py-3 rounded-lg outline-none transition-colors"
                      style={{
                        background: "#F4EEFB",
                        border: "1px solid rgba(10, 21, 48, 0.12)",
                        fontSize: 14,
                        fontFamily: "var(--font-cv-sans), system-ui, sans-serif",
                        color: "#0A1530",
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "#5645D4"; e.currentTarget.style.background = "#ffffff"; }}
                      onBlur={(e)  => { e.currentTarget.style.borderColor = "rgba(10, 21, 48, 0.12)"; e.currentTarget.style.background = "#F4EEFB"; }}
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

                  <div style={{ marginTop: 28 }}>
                  <button
                    type="submit"
                    disabled={loading || googleLoading}
                    className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 transition-opacity"
                    style={{
                      background: "#5645D4",
                      color: "#F4EEFB",
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

                <p className="text-center mt-6" style={{ fontSize: 12, color: "#938FB8" }}>
                  No account yet?{" "}
                  <Link href="/auth/signup" style={{ color: "#5645D4", fontWeight: 500, textDecoration: "none" }}>
                    Sign up free
                  </Link>
                </p>
          </div>
        </main>

        {/* Trust strip */}
        <footer className="px-5 pb-10 pt-2">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mx-auto" style={{ maxWidth: 560 }}>
            {["5 AU sources", "AI-ranked feed", "Visa signal", "3-day trial"].map((label) => (
              <li key={label} className="flex items-center gap-1.5" style={{ fontSize: 12, color: "#938FB8" }}>
                <span className="inline-block rounded-full" style={{ width: 4, height: 4, background: "#5645D4" }} />
                {label}
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  );
}
