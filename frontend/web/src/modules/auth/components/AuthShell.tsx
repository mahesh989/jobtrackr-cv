/**
 * Shared two-panel layout for the auth screens: brand panel (desktop),
 * mobile header, centred form card, and trust strip. Extracted from the
 * previously-duplicated login/signup page JSX — the per-page differences
 * (headline, tagline, switch link, trust labels) arrive as props; the form
 * itself is `children`, rendered inside the card.
 */

import Link from "next/link";
import { BRAND_PANEL_FEATURES, LOGO_SVG } from "./brand";

interface AuthShellProps {
  /** Serif headline in the brand panel, e.g. <>Find your next role<br /><em>…</em></> */
  headline: React.ReactNode;
  /** Paragraph under the headline in the brand panel. */
  tagline: string;
  /** Link to the opposite auth screen, e.g. "Need an account? Sign up". */
  switchPrompt: string;
  switchHref: string;
  switchLabel: string;
  /** Labels in the trust strip under the form. */
  trustLabels: string[];
  /** Form card contents. */
  children: React.ReactNode;
}

export function AuthShell({
  headline,
  tagline,
  switchPrompt,
  switchHref,
  switchLabel,
  trustLabels,
  children,
}: AuthShellProps) {
  const switchLink = (
    <Link href={switchHref} className="group text-[13px] cursor-pointer" style={{ color: "#475467" }}>
      {switchPrompt}{" "}
      <span className="underline-offset-2 group-hover:underline" style={{ color: "#0B7D74", fontWeight: 500 }}>
        {switchLabel}
      </span>
    </Link>
  );

  return (
    <div
      className="min-h-screen flex"
      style={{ fontFamily: "var(--font-cv-sans), system-ui, sans-serif", color: "#0E141B" }}
    >
      {/* ── Brand panel (desktop only) ── */}
      <aside
        className="hidden lg:flex flex-col justify-between w-[440px] shrink-0 px-12 py-10"
        style={{ background: "#ECFBF8", color: "#0E141B" }}
      >
        <Link href="/" className="flex items-center">
          {/* Logo is the full "JobTrackr" wordmark — no separate badge/text. */}
          {LOGO_SVG}
        </Link>

        <div>
          <h2
            style={{
              fontFamily: "var(--font-cv-serif)",
              fontSize: "clamp(1.75rem, 2.5vw, 2.25rem)",
              lineHeight: 1.15,
              letterSpacing: "-0.6px",
              color: "#0E141B",
              marginBottom: 12,
              fontWeight: 400,
            }}
          >
            {headline}
          </h2>
          <p style={{ color: "rgba(14, 20, 27,0.5)", fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            {tagline}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {BRAND_PANEL_FEATURES.map((f) => (
              <li
                key={f}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  padding: "10px 0",
                  borderBottom: "1px solid rgba(14, 20, 27, 0.08)",
                  color: "rgba(14, 20, 27,0.7)",
                  fontSize: 13, lineHeight: 1.5,
                }}
              >
                <span
                  style={{ width: 5, height: 5, background: "#0B7D74", borderRadius: "50%", flexShrink: 0, marginTop: 5 }}
                />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p style={{ fontSize: 11, color: "rgba(14, 20, 27,0.2)", letterSpacing: 0.3 }}>
          Built for Australian job seekers
        </p>
      </aside>

      {/* ── Form panel ── */}
      <div className="flex-1 flex flex-col" style={{ background: "#F6F8FB" }}>
        {/* Mobile header */}
        <header className="flex lg:hidden items-center justify-between px-8 py-5">
          <Link href="/" className="flex items-center">
            {LOGO_SVG}
          </Link>
          {switchLink}
        </header>

        {/* Desktop top-right link */}
        <div className="hidden lg:flex justify-end px-10 py-6">
          {switchLink}
        </div>

        {/* Form card */}
        <main className="flex-1 flex items-center justify-center px-5 py-10">
          <div
            className="w-full max-w-md rounded-2xl px-10 py-12"
            style={{
              background: "#FFFFFF",
              border: "1px solid #E2E8F0",
              boxShadow: "0 12px 28px -12px rgba(16,24,40,.18), 0 2px 6px rgba(16,24,40,.06)",
            }}
          >
            {children}
          </div>
        </main>

        {/* Trust strip */}
        <footer className="px-5 pb-10 pt-2">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mx-auto" style={{ maxWidth: 560 }}>
            {trustLabels.map((label) => (
              <li key={label} className="flex items-center gap-1.5" style={{ fontSize: 12, color: "#667085" }}>
                <span className="inline-block rounded-full" style={{ width: 4, height: 4, background: "#0B7D74" }} />
                {label}
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  );
}
