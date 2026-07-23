import type { MetadataRoute } from "next";
// Allow crawling of the public marketing/legal surface, but keep the gated
// app, API, auth, and onboarding routes out of the index. `allow: "/"` keeps
// the public pages (/, /pricing, /privacy, /terms) crawlable; the disallow
// list is scoped to path prefixes only — there is deliberately no blanket
// `Disallow: /` that would deindex the whole site.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://jobtrackr.app";
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
