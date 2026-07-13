"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "./AuthShell";
import { PasswordRequirements, passwordMeetsAllRules } from "./PasswordRequirements";
import { ErrorNotice, Spinner, inputStyle } from "./brand";

/**
 * Reached only via a password-recovery session established by
 * modules/auth/server/confirm.ts (type=recovery skips the usual sign-out).
 * On success we sign out deliberately and send the user to a fresh login —
 * same "sign in on purpose" pattern as email confirmation.
 */
export function UpdatePasswordForm() {
  const [password, setPassword]               = useState("");
  const [confirmPassword, setConfirmPassword]  = useState("");
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    </AuthShell>
  );
}
