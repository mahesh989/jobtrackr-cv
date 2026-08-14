/**
 * Regression test for #20 (audit, execution chunk C28): normalizeLocation
 * was `location.split(/[,\s]+/)[0]` — the FIRST whitespace/comma-split
 * token. Every multi-word AU city name got truncated ("Gold Coast" ->
 * "Gold", "Alice Springs" -> "Alice", "Port Macquarie" -> "Port", "Wagga
 * Wagga" -> "Wagga"), sending the wrong search location to the Adzuna API.
 * The docstring only ever claimed the single-word-city + trailing-state
 * cases ("Sydney NSW" -> "Sydney").
 *
 * Fix: strip a trailing AU state token (abbreviation or full name),
 * rather than truncating to the first token — a multi-word city with no
 * state suffix now passes through unchanged.
 */
import { describe, it, expect } from "vitest";
import { normalizeLocation } from "./adzuna.js";

describe("normalizeLocation", () => {
  it("keeps multi-word AU city names with no state suffix intact", () => {
    expect(normalizeLocation("Gold Coast")).toBe("Gold Coast");
    expect(normalizeLocation("Alice Springs")).toBe("Alice Springs");
    expect(normalizeLocation("Port Macquarie")).toBe("Port Macquarie");
    expect(normalizeLocation("Wagga Wagga")).toBe("Wagga Wagga");
  });

  it("still strips a trailing state abbreviation, per the original docstring examples", () => {
    expect(normalizeLocation("Sydney NSW")).toBe("Sydney");
    expect(normalizeLocation("Melbourne, VIC")).toBe("Melbourne");
  });

  it("strips a trailing full state name too", () => {
    expect(normalizeLocation("Perth, Western Australia")).toBe("Perth");
    expect(normalizeLocation("Adelaide South Australia")).toBe("Adelaide");
  });

  it("strips the SA abbreviation (missing from the state list would silently leave it unstripped)", () => {
    expect(normalizeLocation("Adelaide SA")).toBe("Adelaide");
  });

  it("keeps a multi-word city even when a state suffix follows it", () => {
    expect(normalizeLocation("Gold Coast QLD")).toBe("Gold Coast");
    expect(normalizeLocation("Alice Springs, NT")).toBe("Alice Springs");
  });

  it("falls back to Australia for empty input", () => {
    expect(normalizeLocation("")).toBe("Australia");
    expect(normalizeLocation("   ")).toBe("Australia");
  });
});
