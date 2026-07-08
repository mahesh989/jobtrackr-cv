// Canonical public origin for the app, used by metadataBase, the sitemap, and
// robots so they can never drift apart. Reads NEXT_PUBLIC_SITE_URL — the same
// env var the billing checkout/portal routes already use — and falls back to
// the production brand domain.
//
// NOTE: auth/OAuth routes read a *different* var (NEXT_PUBLIC_APP_URL). Those
// two should be unified to one canonical origin to avoid drift; until then,
// SEO metadata standardizes on NEXT_PUBLIC_SITE_URL. Make sure it is set to
// https://jobtrackr.app in Vercel production.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://jobtrackr.app";
