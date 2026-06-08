"use client";

import { useState } from "react";
import { Mail, CheckCircle2, Loader2, LogOut } from "lucide-react";

interface Props {
  /** null = no email integration connected */
  connected: {
    provider:     "google" | "microsoft";
    from_address: string;
  } | null;
  googleConfigured:    boolean;
  microsoftConfigured: boolean;
}

export function EmailIntegrationCard({ connected, googleConfigured, microsoftConfigured }: Props) {
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!confirm("Disconnect your email account? You won't be able to send emails from JobTrackr until you reconnect.")) return;
    setDisconnecting(true);
    try {
      await fetch("/api/auth/email/disconnect", { method: "POST" });
      window.location.reload();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="border border-border rounded-md p-4 bg-surface space-y-3">
      <div className="flex items-center gap-2">
        <Mail className="w-4 h-4 text-text-2" />
        <h3 className="text-[13px] font-semibold text-text">Email account</h3>
      </div>
      <p className="text-[12px] text-text-3 leading-relaxed">
        Connect Gmail or Outlook to send application emails directly from JobTrackr.
        Your cover letter is used as the email body; your tailored CV PDF is attached automatically.
      </p>

      {connected ? (
        /* ── Connected state ── */
        <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-black dark:text-white">
                  {connected.provider === "google" ? "Gmail" : "Outlook"} connected
                </p>
                <p className="text-[11px] text-black dark:text-white truncate">
                  {connected.from_address}
                </p>
              </div>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-red-600 transition-colors shrink-0 disabled:opacity-40"
            >
              {disconnecting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <LogOut  className="w-3 h-3" />
              }
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        /* ── Connect buttons ── */
        <div className="flex flex-wrap gap-2">
          {googleConfigured && (
            <a
              href="/api/auth/email/google"
              className="inline-flex items-center gap-2 gh-btn text-[12px] px-3 py-1.5"
            >
              {/* Google G icon */}
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Connect Gmail
            </a>
          )}
          {microsoftConfigured && (
            <a
              href="/api/auth/email/outlook"
              className="inline-flex items-center gap-2 gh-btn text-[12px] px-3 py-1.5"
            >
              {/* Microsoft icon */}
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#F25022" d="M1 1h10v10H1z"/>
                <path fill="#7FBA00" d="M13 1h10v10H13z"/>
                <path fill="#00A4EF" d="M1 13h10v10H1z"/>
                <path fill="#FFB900" d="M13 13h10v10H13z"/>
              </svg>
              Connect Outlook
            </a>
          )}
          {!googleConfigured && !microsoftConfigured && (
            <p className="text-[12px] text-amber-600 dark:text-amber-400">
              Email provider not configured. Add <code className="font-mono text-[11px]">GOOGLE_CLIENT_ID</code> or{" "}
              <code className="font-mono text-[11px]">MICROSOFT_CLIENT_ID</code> to your environment.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
