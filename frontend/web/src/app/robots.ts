import type { MetadataRoute } from "next";
// Allow crawling of the public marketing/legal surface, but keep the gated
// app, API, auth, and onboarding routes out of the index. `allow: "/"` keeps
// the public pages (/, /pricing, /privacy, /terms) crawlable; the disallow
// list is scoped to path prefixes only — there is deliberately no blanket
// `Disallow: /` that would deindex the whole site.
// C67: fallback was "https://jobtrackr.app" — not this project's domain.
// Production is jobtrackr.com.au (CLAUDE.md's own Production Safety
// section); this fallback only fires when NEXT_PUBLIC_SITE_URL is unset
// (local dev, a misconfigured preview), but should still point somewhere
// real rather than a domain this project has never owned.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://jobtrackr.com.au";
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/", "/api", "/auth", "/onboarding"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
