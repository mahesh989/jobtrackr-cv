import type { MetadataRoute } from "next";
// Lists ONLY the genuinely public, indexable routes — the same set the
// proxy (src/proxy.ts, Next's middleware renamed — see its own header
// comment) allows through without auth. Auth pages, the onboarding gate,
// and every / + /api route are intentionally excluded: they're gated (or
// non-content) and must not be advertised to crawlers.
export default function sitemap(): MetadataRoute.Sitemap {
  // C67: fallback was "https://jobtrackr.app" — not this project's domain.
  // See robots.ts's matching fix for the full rationale.
  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://jobtrackr.com.au";
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/pricing`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
