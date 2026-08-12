/**
 * Regression tests for #51 (audit): scrapeJobUrl.ts ran an unrestricted
 * server-side fetch() on any user-supplied URL — no host, IP, or redirect
 * restriction — reachable by any signed-in user via POST /api/jobs/scrape-url.
 * An attacker could point it at cloud metadata (169.254.169.254), localhost,
 * or an internal RFC1918 service and have the response body (up to 2MB)
 * returned to them.
 *
 * `isPublicIp` is pure and tested directly. `assertPublicUrl`/`fetchPublicUrl`
 * take an injectable DNS lookup (and fetch impl) so no real network/DNS call
 * happens in tests — same DI pattern this repo already uses for I/O
 * boundaries (e.g. syncSubscription.ts's resolveUserId).
 */
import { describe, it, expect, vi } from "vitest";
import { isPublicIp, assertPublicUrl, fetchPublicUrl, SSRFError, type DnsLookup } from "./ssrf";

describe("isPublicIp", () => {
  it.each([
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["203.2.75.1", true], // arbitrary real public AU IP
    ["10.0.0.5", false],
    ["10.255.255.255", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["172.15.255.255", true], // just outside 172.16.0.0/12
    ["172.32.0.0", true],     // just outside 172.16.0.0/12
    ["192.168.1.1", false],
    ["127.0.0.1", false],
    ["0.0.0.0", false],
    ["169.254.169.254", false], // REGRESSION: cloud metadata endpoint — the headline #51 target
    ["169.254.0.1", false],
    ["100.64.0.1", false], // carrier-grade NAT
    ["224.0.0.1", false],  // multicast
    ["255.255.255.255", false], // broadcast
    ["198.18.0.1", false], // benchmarking
    ["192.0.2.1", false],  // TEST-NET-1
    ["198.51.100.1", false], // TEST-NET-2
    ["203.0.113.1", false], // TEST-NET-3
    ["not.an.ip", false],
    ["999.999.999.999", false],
  ])("IPv4 %s → public=%s", (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });

  it.each([
    ["2001:4860:4860::8888", true], // Google public DNS
    ["::1", false],                 // loopback
    ["::", false],                  // unspecified
    ["fe80::1", false],             // link-local
    ["fc00::1", false],             // unique local
    ["fd12:3456:789a::1", false],   // unique local
    ["ff02::1", false],             // multicast
    ["::ffff:169.254.169.254", false], // REGRESSION: IPv4-mapped metadata address
    ["::ffff:8.8.8.8", true],          // IPv4-mapped public address
  ])("IPv6 %s → public=%s", (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });
});

describe("assertPublicUrl", () => {
  function fakeLookup(map: Record<string, string[]>): DnsLookup {
    return async (hostname) => {
      if (!(hostname in map)) throw new Error(`no fake DNS entry for ${hostname}`);
      return map[hostname];
    };
  }

  it("resolves for a hostname that resolves publicly", async () => {
    const lookup = fakeLookup({ "jobs.example.com": ["8.8.8.8"] });
    await expect(assertPublicUrl("https://jobs.example.com/role", lookup)).resolves.toBeInstanceOf(URL);
  });

  it("REGRESSION (#51): rejects a hostname that resolves to the cloud metadata address", async () => {
    const lookup = fakeLookup({ "attacker.example.com": ["169.254.169.254"] });
    await expect(assertPublicUrl("http://attacker.example.com/", lookup)).rejects.toThrow(SSRFError);
  });

  it("REGRESSION (#51): rejects a literal internal IP with no DNS lookup involved", async () => {
    const lookup = vi.fn();
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/", lookup as unknown as DnsLookup))
      .rejects.toThrow(SSRFError);
    expect(lookup).not.toHaveBeenCalled(); // literal IPs skip DNS entirely
  });

  it("rejects a private RFC1918 address", async () => {
    const lookup = fakeLookup({ "internal.example.com": ["10.0.0.5"] });
    await expect(assertPublicUrl("http://internal.example.com/", lookup)).rejects.toThrow(SSRFError);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(SSRFError);
    await expect(assertPublicUrl("ftp://example.com/")).rejects.toThrow(SSRFError);
  });

  it("rejects an unparseable URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toThrow(SSRFError);
  });

  it("rejects when DNS resolution fails", async () => {
    const lookup: DnsLookup = async () => { throw new Error("ENOTFOUND"); };
    await expect(assertPublicUrl("https://does-not-exist.invalid/", lookup)).rejects.toThrow(SSRFError);
  });

  it("rejects if ANY resolved address is non-public, even when others are public", async () => {
    const lookup = fakeLookup({ "mixed.example.com": ["8.8.8.8", "169.254.169.254"] });
    await expect(assertPublicUrl("https://mixed.example.com/", lookup)).rejects.toThrow(SSRFError);
  });
});

describe("fetchPublicUrl", () => {
  function fakeLookup(map: Record<string, string[]>): DnsLookup {
    return async (hostname) => {
      if (!(hostname in map)) throw new Error(`no fake DNS entry for ${hostname}`);
      return map[hostname];
    };
  }

  function fakeFetch(responses: Record<string, { status: number; location?: string; body?: string }>) {
    const calls: string[] = [];
    const impl = (async (url: string | URL) => {
      const key = String(url);
      calls.push(key);
      const r = responses[key];
      if (!r) throw new Error(`no fake response registered for ${key}`);
      const headers = new Headers();
      if (r.location) headers.set("location", r.location);
      return new Response(r.body ?? "", { status: r.status, headers });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("REGRESSION (#51): a publicly-resolving URL that redirects to an internal host is blocked before the internal host is ever fetched", async () => {
    const lookup = fakeLookup({
      "public.example.com": ["8.8.8.8"],
      "internal.example.com": ["10.0.0.5"], // never actually queried by fakeFetch — must be blocked first
    });
    const { impl, calls } = fakeFetch({
      "https://public.example.com/start": { status: 302, location: "http://internal.example.com/secret" },
    });

    await expect(
      fetchPublicUrl("https://public.example.com/start", {}, { lookup, fetchImpl: impl }),
    ).rejects.toThrow(SSRFError);

    // The redirect target was validated and rejected — fetchImpl was never
    // called a second time for it (only the first, legitimate hop ran).
    expect(calls).toEqual(["https://public.example.com/start"]);
  });

  it("follows a chain of public redirects to the final response", async () => {
    const lookup = fakeLookup({
      "a.example.com": ["8.8.8.8"],
      "b.example.com": ["8.8.4.4"],
    });
    const { impl } = fakeFetch({
      "https://a.example.com/1": { status: 302, location: "https://b.example.com/2" },
      "https://b.example.com/2": { status: 200, body: "ok" },
    });

    const res = await fetchPublicUrl("https://a.example.com/1", {}, { lookup, fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("throws after exceeding maxRedirects", async () => {
    const lookup = fakeLookup({ "loop.example.com": ["8.8.8.8"] });
    const { impl } = fakeFetch({
      "https://loop.example.com/": { status: 302, location: "https://loop.example.com/" },
    });

    await expect(
      fetchPublicUrl("https://loop.example.com/", {}, { lookup, fetchImpl: impl, maxRedirects: 2 }),
    ).rejects.toThrow(SSRFError);
  });

  it("returns directly when there is no redirect", async () => {
    const lookup = fakeLookup({ "direct.example.com": ["8.8.8.8"] });
    const { impl } = fakeFetch({
      "https://direct.example.com/": { status: 200, body: "hello" },
    });

    const res = await fetchPublicUrl("https://direct.example.com/", {}, { lookup, fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
});
