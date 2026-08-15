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
 *
 * Round 2 (independent review): the state-only strip regressed a case the
 * original (buggy) first-token split handled as a side effect —
 * "Sydney, Australia" no longer reduced to "Sydney" at all, since
 * "Australia" isn't a state token. Added a chained country-suffix strip,
 * only re-running the state strip a second time when the country strip
 * actually removed something — running it unconditionally twice would
 * cascade onto ordinary city names whose own second word happens to be a
 * state name too ("Mount Victoria NSW" would wrongly become "Mount"
 * instead of "Mount Victoria").
 *
 * Round 3 (independent review): round 2's fix for a BARE "Western
 * Australia"/"South Australia" (letting the state-suffix regex match at
 * the very start of the string) accidentally applied to ALL 16 state
 * tokens, not just those two — "NSW", "Victoria", "New South Wales" etc.
 * all wrongly collapsed to "Australia" when entered bare, discarding real
 * location info (and, combined with the `distance` radius param this
 * function's output feeds, turning a state-scoped search into a
 * meaningless country-wide one). Fixed by reverting the state-suffix
 * regex to require a preceding city (matching round 1 and dev-5's
 * behaviour for all 16 bare tokens again) and instead giving the
 * country-suffix strip the same Western/South lookbehind guard
 * seekDirect.ts already uses — a bare state name now survives completely
 * unchanged, same as seekDirect.ts, rather than falling back to
 * "Australia".
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

  it("strips a redundant trailing country suffix (round 2)", () => {
    expect(normalizeLocation("Sydney, Australia")).toBe("Sydney");
    expect(normalizeLocation("Sydney Australia")).toBe("Sydney");
  });

  it("fully reduces City, STATE, Australia by chaining both strips (round 2)", () => {
    expect(normalizeLocation("Gold Coast, QLD, Australia")).toBe("Gold Coast");
  });

  it.each([
    "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT",
    "New South Wales", "Victoria", "Queensland", "Western Australia",
    "South Australia", "Tasmania", "Australian Capital Territory",
    "Northern Territory",
  ])(
    "leaves bare state token %s unchanged — round 2's fix regressed all 16, not just the 2 tested (round 3)",
    (token) => {
      expect(normalizeLocation(token)).toBe(token);
    },
  );

  it("does not cascade the state strip onto a city name containing a state word, when there is no country suffix to trigger the second pass (round 2 regression guard)", () => {
    expect(normalizeLocation("Mount Victoria NSW")).toBe("Mount Victoria");
    expect(normalizeLocation("Port Victoria SA")).toBe("Port Victoria");
  });

  it("leaves a fully-qualified street address's numeric suffix untouched", () => {
    expect(normalizeLocation("Sydney NSW 2000")).toBe("Sydney NSW 2000");
  });

  it("known, accepted tradeoff: a BARE city name whose own last word is a real state name still truncates — not solvable without a place-name gazetteer, see the source comment", () => {
    expect(normalizeLocation("Mount Victoria")).toBe("Mount");
  });

  it("the cascade guard holds under a layered input (state-shaped city word + real state + country, all three at once)", () => {
    expect(normalizeLocation("Mount Victoria, QLD, Australia")).toBe("Mount Victoria");
  });
});
