/**
 * Wiring test for #51: proves scrapeJobUrl actually routes its fetch
 * through the SSRF guard (fetchPublicUrl from ./ssrf) rather than calling
 * fetch() directly, and that an SSRFError surfaces as a generic
 * user-facing message rather than leaking internal resolution detail.
 * The guard logic itself (isPublicIp / assertPublicUrl / fetchPublicUrl)
 * has its own exhaustive regression suite in ssrf.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const fetchPublicUrlMock = vi.fn();
vi.mock("@/lib/ssrf", async () => {
  const actual = await vi.importActual<typeof import("./ssrf")>("./ssrf");
  return {
    ...actual,
    fetchPublicUrl: (...args: unknown[]) => fetchPublicUrlMock(...args),
  };
});

import { scrapeJobUrl } from "./scrapeJobUrl";
import { SSRFError } from "./ssrf";

const VALID_JOB_HTML = `
<html><head>
<script type="application/ld+json">
{
  "@type": "JobPosting",
  "title": "Registered Nurse",
  "description": "${"We are looking for a compassionate registered nurse to join our team. ".repeat(6)}",
  "hiringOrganization": { "name": "Acme Health" }
}
</script>
</head><body></body></html>
`;

describe("scrapeJobUrl SSRF wiring", () => {
  it("REGRESSION (#51): routes the fetch through fetchPublicUrl (the SSRF guard), not a bare fetch()", async () => {
    fetchPublicUrlMock.mockResolvedValue(new Response(VALID_JOB_HTML, { status: 200 }));

    await scrapeJobUrl("https://jobs.example.com/role/123");

    expect(fetchPublicUrlMock).toHaveBeenCalledTimes(1);
    expect(fetchPublicUrlMock.mock.calls[0][0]).toBe("https://jobs.example.com/role/123");
  });

  it("REGRESSION (#51): an SSRFError from the guard surfaces as a generic message, not the internal detail", async () => {
    fetchPublicUrlMock.mockRejectedValue(new SSRFError("Host x resolves to a non-public address (169.254.169.254)"));

    await expect(scrapeJobUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      "URL is not allowed",
    );
    // The specific resolved-IP detail must not leak to the caller.
    await expect(scrapeJobUrl("http://169.254.169.254/latest/meta-data/")).rejects.not.toThrow(
      /169\.254\.169\.254.*resolves/,
    );
  });

  it("a non-SSRF fetch failure still propagates (unrelated to this guard)", async () => {
    fetchPublicUrlMock.mockRejectedValue(new Error("network error"));
    await expect(scrapeJobUrl("https://jobs.example.com/role/123")).rejects.toThrow("network error");
  });

  it("still returns a parsed job on the happy path", async () => {
    fetchPublicUrlMock.mockResolvedValue(new Response(VALID_JOB_HTML, { status: 200 }));

    const result = await scrapeJobUrl("https://jobs.example.com/role/123?utm_source=x");

    expect(result.title).toBe("Registered Nurse");
    expect(result.company).toBe("Acme Health");
    expect(result.source_url).toBe("https://jobs.example.com/role/123"); // query stripped
  });
});
