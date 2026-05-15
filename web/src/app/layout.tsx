import type { Metadata } from "next";
import { Sofia_Sans, DM_Serif_Display, DM_Sans, Manrope, Noto_Serif } from "next/font/google";
import "./globals.css";

// ── Default theme fonts (current JobTrackr look) ──────────────────────────
const sofiaSans = Sofia_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const dmSerif = DM_Serif_Display({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400"],
  style:   ["normal", "italic"],
});

const dmSans = DM_Sans({
  variable: "--font-marketing",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

// ── cv-magic theme fonts (Classic / Gilded Noir / Notion / Clay) ──────────
// Themes other than 'default' swap to these via CSS @ font-family override.
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
  description: "Find your next role while you sleep. JobTrackr scans 21+ Australian job sources daily, scores each listing with AI, and flags visa sponsorship — so you only review what matters.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sofiaSans.variable} ${dmSerif.variable} ${dmSans.variable} ${manrope.variable} ${notoSerif.variable} h-full antialiased`}
    >
      <head>
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
                var t = localStorage.getItem('jobtrackr-theme');
                if (t && t !== 'default' && /^(classic|gilded-noir|notion|clay)$/.test(t)) {
                  document.documentElement.classList.add('theme-' + t);
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-canvas text-ink">{children}</body>
    </html>
  );
}
