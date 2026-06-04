import type { Metadata } from "next";
import { Sofia_Sans, DM_Serif_Display, Manrope, Noto_Serif } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

// ── "Default" theme fonts (original JobTrackr look) ───────────────────────
// The user-facing default theme is 'notion' (see the FOUC guard below), which
// uses the cv-magic fonts (Manrope / Noto Serif) declared further down. These
// two only apply when a user explicitly picks the "Default" theme, so we set
// preload: false — the browser fetches them lazily on theme switch instead of
// preloading them on every route (incl. the public marketing/login pages).
const sofiaSans = Sofia_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  preload: false,
});

const dmSerif = DM_Serif_Display({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400"],
  style:   ["normal", "italic"],
  display: "swap",
  preload: false,
});

// ── cv-magic theme fonts (Classic / Gilded Noir / Notion / Clay) ──────────
// The 'notion' default theme uses these, so they keep the default preload.
const manrope = Manrope({
  variable: "--font-cv-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

const notoSerif = Noto_Serif({
  variable: "--font-cv-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "JobTrackr — Stop hunting. Start tracking.",
  description: "Find your next role while you sleep. JobTrackr scans Australia's major job sources daily, scores each listing with AI, and flags visa sponsorship — so you only review what matters.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Origin of the Supabase project — every page makes auth/data calls here, so
  // warming the TLS handshake early shaves latency off the first request.
  // Derived from the public env var so there's no hardcoded project ref.
  let supabaseOrigin: string | null = null;
  try {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
      supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
    }
  } catch {
    supabaseOrigin = null;
  }

  return (
    <html
      lang="en"
      className={`${sofiaSans.variable} ${dmSerif.variable} ${manrope.variable} ${notoSerif.variable} h-full antialiased`}
    >
      <head>
        {/* Resource hints — warm connections to third parties we always hit.
            next/font self-hosts fonts, so no Google Fonts preconnect needed. */}
        {supabaseOrigin && (
          <>
            <link rel="preconnect" href={supabaseOrigin} crossOrigin="" />
            <link rel="dns-prefetch" href={supabaseOrigin} />
          </>
        )}
        <link rel="dns-prefetch" href="https://js.stripe.com" />
        <link rel="dns-prefetch" href="https://accounts.google.com" />
        {/*
          FOUC guard for the theme system. Runs synchronously before any
          React code, so users on a non-Classic theme don't briefly see
          Classic flash before their saved theme applies. Kept tiny on
          purpose — anything heavier should live in ThemeProvider.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('jobtrackr-theme') || 'notion';
                if (t !== 'default' && /^(classic|gilded-noir|notion|clay)$/.test(t)) {
                  document.documentElement.classList.add('theme-' + t);
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-text">
        {children}
        {/* Real-user Core Web Vitals (LCP/CLS/INP) per route — feeds the
            Vercel Speed Insights dashboard. Loads after hydration, so it
            doesn't affect the metrics it measures. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
