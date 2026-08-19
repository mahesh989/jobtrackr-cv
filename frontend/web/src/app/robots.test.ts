import { afterEach, describe, expect, it, vi } from "vitest";

// C67: robots()'s SITE_URL fallback was "https://jobtrackr.app" — not this
// project's domain (production is jobtrackr.com.au).

const ORIGINAL = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL;
  vi.resetModules();
});

describe("robots()", () => {
  it("falls back to the real production domain when NEXT_PUBLIC_SITE_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const { default: robots } = await import("./robots");
    const result = robots();
    expect(result.host).toBe("https://jobtrackr.com.au");
    expect(result.sitemap).toBe("https://jobtrackr.com.au/sitemap.xml");
  });

  it("uses NEXT_PUBLIC_SITE_URL when set", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.com";
    const { default: robots } = await import("./robots");
    const result = robots();
    expect(result.host).toBe("https://staging.example.com");
  });
});
