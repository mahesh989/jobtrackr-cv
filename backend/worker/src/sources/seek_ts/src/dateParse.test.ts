/**
 * C67: seek.ts (this actor's consumer) declares listingDate as an ISO date
 * string by contract, but the scraped card text is a human-readable
 * relative string ("16m ago", "8h ago", "9d ago•Expiring") — new
 * Date("9d ago") is Invalid Date, so posted_at silently came out null for
 * every actor-sourced SEEK job. Formats below verified live against
 * seek.com.au job cards, 2026-08.
 */
import { describe, it, expect } from "vitest";
import { parseListingDateToIso } from "./dateParse.js";

const NOW = new Date("2026-08-19T12:00:00.000Z").getTime();

describe("parseListingDateToIso", () => {
  it("converts minutes-ago text to an ISO timestamp", () => {
    expect(parseListingDateToIso("16m ago", NOW)).toBe("2026-08-19T11:44:00.000Z");
  });

  it("converts hours-ago text to an ISO timestamp", () => {
    expect(parseListingDateToIso("8h ago", NOW)).toBe("2026-08-19T04:00:00.000Z");
  });

  it("converts days-ago text to an ISO timestamp", () => {
    expect(parseListingDateToIso("5d ago", NOW)).toBe("2026-08-14T12:00:00.000Z");
  });

  it("REGRESSION: converts a compound suffix like '9d ago•Expiring' by reading the leading duration", () => {
    expect(parseListingDateToIso("9d ago•Expiring", NOW)).toBe("2026-08-10T12:00:00.000Z");
  });

  it("passes 'Featured' through unchanged — the consumer's own filter depends on this exact string", () => {
    expect(parseListingDateToIso("Featured", NOW)).toBe("Featured");
  });

  it("is case-insensitive for the 'featured' passthrough", () => {
    expect(parseListingDateToIso("featured", NOW)).toBe("featured");
  });

  it("passes an unrecognised format through unchanged rather than corrupting it", () => {
    expect(parseListingDateToIso("Some new SEEK label", NOW)).toBe("Some new SEEK label");
  });

  it("passes an empty string through unchanged", () => {
    expect(parseListingDateToIso("", NOW)).toBe("");
  });
});
