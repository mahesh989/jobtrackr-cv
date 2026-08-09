/**
 * Shared two-panel layout for the auth screens: brand panel (desktop),
 * mobile header, centred form card, and trust strip. Extracted from the
 * previously-duplicated login/signup page JSX — the per-page differences
 * (headline, tagline, switch link, trust labels) arrive as props; the form
 * itself is `children`, rendered inside the card.
 */

import Link from "next/link";
import { BRAND_PANEL_FEATURES, LOGO_SVG } from "./brand";

interface ShellProps {
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

export function Shell({
  headline,
  tagline,
  switchPrompt,
  switchHref,
  switchLabel,
  trustLabels,
  children,
}: ShellProps) {
  const switchLink = (
    <Link href={switchHref} className="group text-body cursor-pointer text-text-2">
      {switchPrompt}{" "}
      <span className="underline-offset-2 group-hover:underline font-medium text-[var(--brand)]">
        {switchLabel}
      </span>
    </Link>
  );

  return (
    // Scoped token override (see the comment above .auth-shell in
    // globals.css) — this is what makes the fixed palette below real
    // regardless of a signed-out visitor's last-chosen theme on <html>.
    <div
      className="auth-shell min-h-screen flex text-text"
      style={{ fontFamily: "var(--font-cv-sans), system-ui, sans-serif" }}
    >
      {/* ── Brand panel (desktop only) ── */}
      <aside className="hidden lg:flex flex-col justify-between w-[440px] shrink-0 px-12 py-10 bg-[var(--auth-panel)] text-text">
        <Link href="/" className="flex items-center">
          {/* Logo is the full "JobTrackr" wordmark — no separate badge/text. */}
          {LOGO_SVG}
        </Link>

        <div>
          <h2
            className="text-text"
            style={{
              fontFamily: "var(--font-cv-serif)",
              fontSize: "clamp(1.75rem, 2.5vw, 2.25rem)",
              lineHeight: 1.15,
              letterSpacing: "-0.6px",
              marginBottom: 12,
              fontWeight: 400,
            }}
          >
            {headline}
          </h2>
          <p className="text-text/50" style={{ fontSize: 14, lineHeight: 1.7, fontWeight: 300, marginBottom: 28 }}>
            {tagline}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {BRAND_PANEL_FEATURES.map((f) => (
              <li
                key={f}
                className="flex items-start gap-2.5 py-2.5 border-b border-text/8 text-text/70"
                style={{ fontSize: 13, lineHeight: 1.5 }}
              >
                <span className="w-[5px] h-[5px] mt-[5px] rounded-full shrink-0 bg-[var(--brand)]" />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-text/20" style={{ fontSize: 11, letterSpacing: 0.3 }}>
          Built for Australian job seekers
        </p>
      </aside>

      {/* ── Form panel ── */}
      <div className="flex-1 flex flex-col bg-surface-2">
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
          <div className="w-full max-w-md rounded-2xl px-10 py-12 bg-surface border border-border shadow-[0_12px_28px_-12px_rgba(16,24,40,.18),0_2px_6px_rgba(16,24,40,.06)]">
            {children}
          </div>
        </main>

        {/* Trust strip */}
        <footer className="px-5 pb-10 pt-2">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mx-auto" style={{ maxWidth: 560 }}>
            {trustLabels.map((label) => (
              <li key={label} className="flex items-center gap-1.5 text-text-3" style={{ fontSize: 12 }}>
                <span className="inline-block rounded-full w-1 h-1 bg-[var(--brand)]" />
                {label}
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  );
}
