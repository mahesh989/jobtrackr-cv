/**
 * Shared branding pieces for the auth screens (login / signup).
 *
 * These pages are deliberately hand-styled to match the Classic theme's
 * canonical palette (see :root.theme-classic in globals.css) but do NOT
 * consume the app theme tokens directly — they render the same way
 * regardless of a logged-in user's own theme choice, since there's no theme
 * preference yet at the pre-login stage.
 */

export const TURNSTILE_CONFIGURED = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export const BRAND_PANEL_FEATURES = [
  "Australia's major sources scanned every night",
  "AI relevance scoring — best matches at the top",
  "Visa sponsorship signal on every listing",
  "Duplicates collapsed across all boards",
];

// eslint-disable-next-line @next/next/no-img-element
export const LOGO_SVG = <img src="/logo-wordmark.png" alt="JobTrackr" style={{ height: 30, width: "auto", objectFit: "contain" }} />;

export const GOOGLE_SVG = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

export const inputStyle = {
  background: "#F1F5F9",
  border: "1px solid #E2E8F0",
  fontSize: 14,
  fontFamily: "var(--font-cv-sans), system-ui, sans-serif",
  color: "#0F172A",
} as React.CSSProperties;

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle opacity="0.25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path opacity="0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2.5 rounded-md"
      style={{ background: "#fff0ee", border: "1px solid rgba(207, 34, 46, 0.2)" }}
    >
      <svg width="16" height="16" fill="#cf222e" viewBox="0 0 20 20" className="mt-0.5 shrink-0">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
      </svg>
      <p style={{ color: "#cf222e", fontSize: 12 }}>{message}</p>
    </div>
  );
}
