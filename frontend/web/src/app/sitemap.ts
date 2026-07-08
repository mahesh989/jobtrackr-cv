import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Lists ONLY the genuinely public, indexable routes — the same set the
// middleware allows through without auth (see src/middleware.ts). Auth pages,
// the onboarding gate, and every /dashboard + /api route are intentionally
// excluded: they're gated (or non-content) and must not be advertised to
// crawlers.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/pricing`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
