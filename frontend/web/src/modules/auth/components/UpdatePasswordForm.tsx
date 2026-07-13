"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "./AuthShell";
import { PasswordRequirements, passwordMeetsAllRules } from "./PasswordRequirements";
import { ErrorNotice, Spinner, inputStyle } from "./brand";

type SessionState = "checking" | "ready" | "missing";

/**
 * Reached only via a password-recovery session established by
 * modules/auth/server/confirm.ts (type=recovery skips the usual sign-out).
 * On success we sign out deliberately and send the user to a fresh login —
 * same "sign in on purpose" pattern as email confirmation.
 *
 * The recovery session can arrive as a URL hash fragment
 * (#access_token=...) rather than a cookie already set server-side — the
 * browser client's detectSessionInUrl auto-consumes that on mount, but it's
 * asynchronous, so we explicitly wait for + verify a session before letting
 * the user submit. A genuinely expired/reused link lands here with no
 * session at all; showing the form anyway would just fail confusingly on
 * submit instead of explaining what's wrong.
 */
export function UpdatePasswordForm() {
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [password, setPassword]               = useState("");
  const [confirmPassword, setConfirmPassword]  = useState("");
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setSessionState(user ? "ready" : "missing");
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
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
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    await supabase.auth.signOut();
    // Full page navigation — see LoginForm.tsx for why (stale-RSC blank
    // screen risk right after a session change with router.push+refresh).
    window.location.href = "/auth/login?confirmed=1";
  }

  return (
    <AuthShell
      headline={<>Set a new<br /><em style={{ fontStyle: "italic", color: "#0B7D74" }}>password.</em></>}
      tagline="Choose a strong password you haven't used elsewhere."
      switchPrompt="Changed your mind?"
      switchHref="/auth/login"
      switchLabel="Sign in"
      trustLabels={["5 AU sources", "AI-ranked feed", "Visa signal", "3-day trial"]}
    >
      {sessionState === "checking" && (
        <div className="flex flex-col items-center py-10 text-center">
          <Spinner size={24} />
          <p className="mt-3" style={{ color: "#475467", fontSize: 13 }}>Verifying your reset link…</p>
        </div>
      )}

      {sessionState === "missing" && (
        <div className="text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "#FCE7E7" }}>
            <svg width="22" height="22" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className="mb-2" style={{ fontFamily: "var(--font-cv-serif)", fontSize: 24, lineHeight: 1.2, letterSpacing: "-0.5px" }}>
            This link is invalid or expired
          </h1>
          <p style={{ color: "#475467", fontSize: 14, lineHeight: 1.65, fontWeight: 300 }}>
            Password reset links can only be used once and expire after a while. Request a new one to continue.
          </p>
          <Link
            href="/auth/forgot-password"
            className="mt-6 inline-block text-[13px] font-semibold rounded-lg px-5 py-2.5 transition-opacity hover:opacity-90"
            style={{ background: "#0B7D74", color: "#FFFFFF" }}
          >
            Request a new link
          </Link>
        </div>
      )}

      {sessionState === "ready" && (
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
        Choose a new password.
      </h1>
      <p style={{ color: "#475467", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
        You&apos;ll be signed in with this the next time you log in.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="password" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>
            New password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a password"
            autoFocus
            className="w-full px-4 py-3 rounded-lg outline-none transition-colors"
            style={inputStyle}
            onFocus={(e) => { e.currentTarget.style.borderColor = "#0B7D74"; e.currentTarget.style.background = "#FFFFFF"; }}
            onBlur={(e)  => { e.currentTarget.style.borderColor = "#E2E8F0"; e.currentTarget.style.background = "#EEF2F7"; }}
          />
          <PasswordRequirements password={password} />
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block mb-2" style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.2 }}>
            Confirm new password
          </label>
          <input
            id="confirmPassword"
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Re-enter your password"
            className="w-full px-4 py-3 rounded-lg outline-none transition-colors"
            style={{
              ...inputStyle,
              borderColor: confirmPassword && confirmPassword !== password ? "#cf222e" : "#E2E8F0",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "#0B7D74"; e.currentTarget.style.background = "#FFFFFF"; }}
            onBlur={(e)  => {
              e.currentTarget.style.borderColor = confirmPassword && confirmPassword !== password ? "#cf222e" : "#E2E8F0";
              e.currentTarget.style.background = "#EEF2F7";
            }}
          />
          {confirmPassword.length > 0 && confirmPassword !== password && (
            <p className="mt-1.5 text-[11px]" style={{ color: "#cf222e" }}>Passwords do not match.</p>
          )}
        </div>

        {error && <ErrorNotice message={error} />}

        <button
          type="submit"
          disabled={loading || !passwordMeetsAllRules(password) || password !== confirmPassword}
          className="w-full flex items-center justify-center gap-2 rounded-lg py-3.5 mt-2 transition-opacity hover:opacity-90 disabled:cursor-not-allowed cursor-pointer"
          style={{ background: "#0B7D74", color: "#FFFFFF", fontSize: 14, fontWeight: 500, opacity: loading ? 0.7 : 1 }}
        >
          {loading ? (
            <>
              <Spinner />
              Updating…
            </>
          ) : (
            "Update password"
          )}
        </button>
      </form>
        </>
      )}
    </AuthShell>
  );
}
