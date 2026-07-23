// Apify Proxy URL builder — shared by all scrapers that need Cloudflare bypass
// (currently seekDirect for /jobs + /job/<id>, careerjet for /jobad/<hash>).
//
// Why Apify Proxy: the SEEK Apify actor already uses it internally; this lets
// the Node worker reuse the same residential AU IPs from outside any actor,
// solving the "Fly datacenter IP gets 403'd by Cloudflare" problem at the
// got-scraping layer.
//
// Setup (once per Fly app):
//   1. Grab your proxy password from https://console.apify.com/account/integrations
//      (it is *different* from APIFY_TOKEN — proxy password is its own field).
//   2. `fly secrets set APIFY_PROXY_PASSWORD=<password> -a jobtrackr-worker`
//
// Without APIFY_PROXY_PASSWORD set, every helper here returns undefined and
// callers fall back to direct (no proxy) requests. That keeps local dev
// working without secrets and gracefully degrades if the secret is missing
// in production.

const APIFY_PROXY_HOST = "proxy.apify.com";
const APIFY_PROXY_PORT = "8000";

/**
 * Build an Apify Proxy URL for got-scraping.
 *
 * `groups` chooses the proxy pool:
 *   - "RESIDENTIAL"  — real Australian home IPs, bypasses Cloudflare. ~$8/GB.
 *   - "SHARED"       — datacenter IPs, free on Apify plans. Will be blocked
 *                      by Cloudflare same as Fly's IP — don't use for SEEK.
 *   - undefined      — Apify's automatic pool (mostly datacenter — also bad
 *                      for Cloudflare-protected sites).
 *
 * `country` restricts geo of the exit IP. Use "AU" for SEEK/Careerjet so
 * the rendered pages show AU listings + AU salaries + AU spelling.
 *
 * Returns undefined when APIFY_PROXY_PASSWORD is not set, so callers can
 * conditionally enable proxy with one ternary:
 *
 *     const proxyUrl = getApifyProxyUrl({ group: "RESIDENTIAL", country: "AU" });
 *     await gotScraping({ url, ...(proxyUrl && { proxyUrl }) });
 */
export function getApifyProxyUrl(opts: {
  group?:   "RESIDENTIAL" | "SHARED";
  country?: string;            // 2-letter ISO code, uppercase
} = {}): string | undefined {
  const password = process.env.APIFY_PROXY_PASSWORD;
  if (!password) return undefined;

  // Apify proxy username encodes options as "groups-X,country-Y,session-Z".
  // "auto" picks any IP from the chosen pool with no session pinning, which
  // is what we want for one-shot stateless scrapes.
  const parts: string[] = ["auto"];
  if (opts.group)   parts.push(`groups-${opts.group}`);
  if (opts.country) parts.push(`country-${opts.country}`);

  const username = parts.join(",");
  // password may contain special chars; URL-encode just in case
  const safePass = encodeURIComponent(password);
  return `http://${username}:${safePass}@${APIFY_PROXY_HOST}:${APIFY_PROXY_PORT}`;
}


