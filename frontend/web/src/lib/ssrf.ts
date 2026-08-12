/**
 * SSRF guard for outbound URL fetches initiated by user-supplied URLs
 * (currently: scrapeJobUrl.ts's user-pasted job page fetch, #51).
 *
 * Without a guard, an attacker can point a server-side fetch at internal
 * addresses — cloud metadata (169.254.169.254), localhost, or private
 * RFC1918 ranges — to exfiltrate internal data or reach internal services.
 * Mirrors backend/api/app/security/ssrf.py's threat model and API shape
 * (assert_public_url / safe_get) so both stacks reason about this the same
 * way; kept as a separate TS implementation since Node's fetch/dns differ
 * from Python's httpx/ipaddress.
 *
 * `assertPublicUrl` resolves the host and rejects any non-public address.
 * `fetchPublicUrl` validates *every* redirect hop (redirect: "manual" so we
 * can inspect each Location before following it), so a public URL that
 * redirects to an internal one is also blocked.
 *
 * Residual risk: DNS rebinding (the name resolves to a public IP at
 * validation time and a private IP when fetch() actually connects).
 * Pinning the validated IP would close that gap; out of scope here, noted
 * for future hardening (same stance as ssrf.py).
 */
import dns from "node:dns";
import net from "node:net";

export class SSRFError extends Error {}

function isPublicIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0) return false;                                   // 0.0.0.0/8 — unspecified / "this network"
  if (a === 10) return false;                                   // 10.0.0.0/8 — private
  if (a === 100 && b >= 64 && b <= 127) return false;           // 100.64.0.0/10 — carrier-grade NAT
  if (a === 127) return false;                                  // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return false;                     // 169.254.0.0/16 — link-local (cloud metadata!)
  if (a === 172 && b >= 16 && b <= 31) return false;             // 172.16.0.0/12 — private
  if (a === 192 && b === 0 && c === 0) return false;             // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false;             // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 168) return false;                      // 192.168.0.0/16 — private
  if (a === 198 && (b === 18 || b === 19)) return false;         // 198.18.0.0/15 — benchmarking
  if (a === 198 && b === 51 && c === 100) return false;          // 198.51.100.0/24 — TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;           // 203.0.113.0/24 — TEST-NET-3
  if (a >= 224) return false;                                    // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPublicIPv4(v4Mapped[1]); // unwrap IPv4-mapped IPv6, e.g. ::ffff:169.254.169.254
  if (lower === "::" || lower === "::1") return false;           // unspecified / loopback
  if (/^fe[89ab]/.test(lower)) return false;                     // fe80::/10 — link-local
  if (/^f[cd]/.test(lower)) return false;                        // fc00::/7 — unique local
  if (lower.startsWith("ff")) return false;                      // ff00::/8 — multicast
  return true;
}

export function isPublicIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) return isPublicIPv6(ip);
  return false;
}

export type DnsLookup = (hostname: string) => Promise<string[]>;

export const defaultDnsLookup: DnsLookup = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

/** Raise SSRFError unless `rawUrl` is http(s) and every resolved IP is public. */
export async function assertPublicUrl(rawUrl: string, lookup: DnsLookup = defaultDnsLookup): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SSRFError("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new SSRFError(`Unsupported URL scheme: ${parsed.protocol || "none"}`);
  }

  const hostname = parsed.hostname;
  if (!hostname) throw new SSRFError("URL has no host");

  const addresses = net.isIP(hostname) ? [hostname] : await (async () => {
    try {
      return await lookup(hostname);
    } catch {
      throw new SSRFError(`Could not resolve host ${hostname}`);
    }
  })();

  if (addresses.length === 0) throw new SSRFError(`Host ${hostname} did not resolve`);
  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new SSRFError(`Host ${hostname} resolves to a non-public address (${addr})`);
    }
  }
  return parsed;
}

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * fetch() that validates the URL AND every redirect hop before following it.
 * Uses redirect:"manual" so each Location header can be inspected/validated
 * instead of the runtime silently following it.
 */
export async function fetchPublicUrl(
  initialUrl: string,
  init: RequestInit,
  opts: { maxRedirects?: number; lookup?: DnsLookup; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookup = opts.lookup ?? defaultDnsLookup;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let current = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, lookup);
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // 3xx with no Location — nothing to follow, return as-is
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new SSRFError("Too many redirects");
}
