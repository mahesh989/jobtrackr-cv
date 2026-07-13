import type { Metadata } from "next";
import { Sofia_Sans, DM_Serif_Display, Manrope, Noto_Serif, Plus_Jakarta_Sans, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// ── "Default" theme fonts (original JobTrackr look) ───────────────────────
// The user-facing default theme is 'aurora-light' (see the FOUC guard below),
// which uses the cv-magic fonts (Manrope / Noto Serif) declared further down. These
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
// No longer the default (Aurora is), so these load lazily on theme switch.
const manrope = Manrope({
  variable: "--font-cv-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  preload: false,
});

const notoSerif = Noto_Serif({
  variable: "--font-cv-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  preload: false,
});

// ── Aurora theme fonts (Aurora Dark / Aurora Light — the new default) ──────
// Body: Plus Jakarta Sans · Display headings: Space Grotesk · Numerals: JetBrains
// Mono. Jakarta + Grotesk carry the default preload (Aurora is the default
// theme); the mono is used less, so it loads lazily.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
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
  metadataBase: new URL(SITE_URL),
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
          React code, so users on a non-Classic theme don't briefly see
          Classic flash before their saved theme applies. Kept tiny on
          purpose — anything heavier should live in ThemeProvider.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var d = document.documentElement;
                var t = localStorage.getItem('jobtrackr-theme') || 'aurora-light';
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
