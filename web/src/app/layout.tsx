import type { Metadata } from "next";
import { Sofia_Sans, DM_Serif_Display, DM_Sans } from "next/font/google";
import "./globals.css";

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
      className={`${sofiaSans.variable} ${dmSerif.variable} ${dmSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-canvas text-ink">{children}</body>
    </html>
  );
}
