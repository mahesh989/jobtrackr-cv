import { afterEach, describe, expect, it, vi } from "vitest";

// C67: sitemap()'s SITE_URL fallback was "https://jobtrackr.app" — not this
// project's domain (production is jobtrackr.com.au).

const ORIGINAL = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL;
  vi.resetModules();
});

describe("sitemap()", () => {
  it("falls back to the real production domain when NEXT_PUBLIC_SITE_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const { default: sitemap } = await import("./sitemap");
    const result = sitemap();
    expect(result[0].url).toBe("https://jobtrackr.com.au/");
    expect(result.every((entry) => entry.url.startsWith("https://jobtrackr.com.au"))).toBe(true);
  });
});
