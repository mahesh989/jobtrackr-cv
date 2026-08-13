import type { Metadata } from "next";
import localFont from "next/font/local";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

// All fonts are self-hosted via next/font/local (latin subset, woff2, in
// src/app/fonts/). next/font/google was dropped because it fetches the CSS +
// woff2 from Google at build time, and Google's file rotation periodically
// 404s those fetches on Vercel, breaking every deploy.
// The weight ranges mirror the static weights the themes actually use.

// ── "Default" theme fonts (original JobTrackr look) ───────────────────────
// These only apply when a user explicitly picks the "Default" theme, so
// preload: false — the browser fetches them lazily on theme switch.
const sofiaSans = localFont({
  src: "./fonts/sofia-sans.woff2",
  variable: "--font-sans",
  weight: "400 700",
  display: "swap",
  preload: false,
});

const dmSerif = localFont({
  src: [
    { path: "./fonts/dm-serif-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/dm-serif-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-serif",
  display: "swap",
  preload: false,
});

// ── cv-magic theme fonts (Classic / Gilded Noir / Notion / Clay) ──────────
// Classic is the new default, so Manrope + Noto Serif are preloaded.
const manrope = localFont({
  src: "./fonts/manrope.woff2",
  variable: "--font-cv-sans",
  weight: "400 700",
  display: "swap",
});

const notoSerif = localFont({
  src: "./fonts/noto-serif.woff2",
  variable: "--font-cv-serif",
  weight: "400 600",
  display: "swap",
});

// ── Aurora theme fonts (Aurora Dark / Aurora Light) ───────────────────────
// No longer the default (Classic is), so these load lazily on theme switch.
const jakarta = localFont({
  src: "./fonts/plus-jakarta-sans.woff2",
  variable: "--font-jakarta",
  weight: "400 700",
  display: "swap",
  preload: false,
});

const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk.woff2",
  variable: "--font-grotesk",
  weight: "400 700",
  display: "swap",
  preload: false,
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono.woff2",
  variable: "--font-jbmono",
  weight: "500 700",
  display: "swap",
  preload: false,
});

const DEFAULT_TITLE = "JobTrackr — Stop hunting. Start tracking.";
const DEFAULT_DESCRIPTION =
  "Find your next role while you sleep. JobTrackr scans Australia's major job sources daily, scores each listing with AI, and flags visa sponsorship — so you only review what matters.";

export const metadata: Metadata = {
  // Resolves all relative URL-based metadata fields (openGraph.url, images,
  // canonicals) to absolute URLs. Derived from the shared SITE_URL so it stays
  // in lockstep with the sitemap and robots output.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://jobtrackr.app"),
  title: DEFAULT_TITLE,
  description: DEFAULT_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "JobTrackr",
    url: "/",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    // 1200×630 preview image — supplied as a follow-up asset (see public/).
    // Until public/og.png exists this reference 404s harmlessly in previews.
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "JobTrackr" }],
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: ["/og.png"],
  },
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
      suppressHydrationWarning
      className={`${sofiaSans.variable} ${dmSerif.variable} ${manrope.variable} ${notoSerif.variable} ${jakarta.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} h-full antialiased`}
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
          React code, so users on a non-default theme don't briefly see the
          default flash before their saved theme applies. Kept tiny on
          purpose — anything heavier should live in ThemeProvider.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var d = document.documentElement;
                var t = localStorage.getItem('jobtrackr-theme') || 'classic';
                if (t !== 'default' && /^(aurora-dark|aurora-light|classic|gilded-noir|notion|clay)$/.test(t)) {
                  d.classList.add('theme-' + t);
                }
                var den = localStorage.getItem('jobtrackr-density');
                if (den === 'compact' || den === 'spacious') {
                  d.setAttribute('data-density', den);
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
