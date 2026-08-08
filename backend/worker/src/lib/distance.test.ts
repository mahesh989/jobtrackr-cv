import { describe, it, expect, vi, afterEach } from "vitest";
import { extractAuState, AU_STATE_RE, geocode } from "./distance.js";

// Regression cases are the three Regis aged-care jobs that leaked into a
// Sydney search on 2026-08-08 — Brisbane suburbs shown at 12.5km, 43.6km and
// 53.4km from a Sydney home. Their real pages were fetched to establish where
// (if anywhere) a state is actually recoverable; those findings are encoded
// here so the partial coverage is a documented fact rather than a surprise.
describe("extractAuState", () => {
  it("reads a state from a URL slug (the Oxley case — no state in the ad body)", () => {
    expect(
      extractAuState(
        "https://regis.avature.net/en_US/careers/JobDetail/Queensland-Australia-Assistant-in-Nursing-Oxley/4211",
        "Join our friendly team at Regis Oxley.",
      ),
    ).toBe("QLD");
  });

  it("reads a state from the ad body (the Birkdale case — no state in the URL)", () => {
    expect(
      extractAuState(
        "https://regis.avature.net/en_US/careers/JobDetail/Assistant-in-Nursing-Birkdale/4245",
        "<p><span>QLD</span></p> Assistant in Nursing at our Birkdale home.",
      ),
    ).toBe("QLD");
  });

  it("returns null when NO state is recoverable (the Greenbank case)", () => {
    // This is the job the ambiguity guard has to catch, because enrichment
    // cannot: nothing on the page or in the URL names a state.
    expect(
      extractAuState(
        "https://regis.avature.net/en_US/careers/JobDetail/Assistant-in-Nursing-Regis-Greenbank/4200",
        "Assistant in Nursing - Regis Greenbank. Join our team.",
      ),
    ).toBeNull();
  });

  it("refuses to guess when a national ad names several states", () => {
    expect(extractAuState("Opportunities across NSW, VIC and QLD")).toBeNull();
  });

  it("ignores lowercase words that merely look like abbreviations", () => {
    // "act", "sa", "wa", "nt" and "vic" appear constantly in ordinary prose;
    // only uppercase forms count, which is how real ads write them.
    expect(extractAuState("You will act as a mentor and support the team")).toBeNull();
    expect(extractAuState("wa nt sa vic")).toBeNull();
  });

  it("matches full state names case-insensitively", () => {
    expect(extractAuState("based in queensland")).toBe("QLD");
    expect(extractAuState("New South Wales")).toBe("NSW");
  });

  it("handles null/undefined inputs", () => {
    expect(extractAuState(null, undefined, "")).toBeNull();
  });
});

describe("AU_STATE_RE — decides whether a location is trusted by the geocoder", () => {
  it("treats board-supplied, state-qualified strings as qualified", () => {
    // SEEK / Adzuna / Careerjet emit these; they must keep the old behaviour.
    for (const s of ["Westmead, NSW", "Sydney, NSW", "Kilsyth Night Duty, VIC"]) {
      expect(AU_STATE_RE.test(s)).toBe(true);
    }
  });

  it("treats the bare aged-care suburbs as unqualified", () => {
    for (const s of ["Birkdale", "Oxley", "Greenbank", "Kanwal Springs Care Community"]) {
      expect(AU_STATE_RE.test(s)).toBe(false);
    }
  });

  it("does not mistake metro-only qualifiers for a state", () => {
    // These have no state token, so a proximity-bias flip on them is still
    // treated as ambiguous — correct, since "Coogee" exists in both NSW and WA.
    expect(AU_STATE_RE.test("Coogee, Eastern Suburbs")).toBe(false);
  });
});

// ── The ambiguity guard ─────────────────────────────────────────────────────
// The Birkdale scenario, reproduced exactly: Nominatim's own best answer is the
// real Brisbane suburb (higher importance, far outside the box), but a
// low-importance Sydney feature sits inside the bias box and wins on the
// proximity bonus alone. That flip is what put a Queensland job 12.5km from a
// Sydney home, so the guard must refuse it.
describe("geocode ambiguity guard", () => {
  const SYDNEY = { lat: -33.87, lng: 151.21 };

  function mockNominatim(results: Array<{ lat: number; lon: number; importance: number }>) {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => results.map((r) => ({ lat: String(r.lat), lon: String(r.lon), importance: r.importance })),
    }));
  }
  afterEach(() => vi.unstubAllGlobals());

  it("drops a bare suburb when the in-box match wins only on proximity bias", async () => {
    mockNominatim([
      { lat: -27.50, lon: 153.20, importance: 0.45 },  // real Birkdale, QLD — far
      { lat: -33.90, lon: 151.10, importance: 0.35 },  // spurious in-box Sydney feature
    ]);
    expect(await geocode("Birkdale", "au", SYDNEY)).toBeNull();
  });

  it("still resolves a bare suburb that is genuinely the best answer", async () => {
    // No flip: the in-box result also has the highest raw importance, so the
    // bonus changed nothing. Normal behaviour must be preserved.
    mockNominatim([
      { lat: -33.88, lon: 151.10, importance: 0.60 },  // real local suburb, in box
      { lat: -27.50, lon: 153.20, importance: 0.20 },  // weak far namesake
    ]);
    const hit = await geocode("Strathfield South", "au", SYDNEY);
    expect(hit).not.toBeNull();
    expect(hit!.lat).toBeCloseTo(-33.88, 2);
  });

  it("trusts a state-qualified string even if the bonus flips the pick", async () => {
    // "…, VIC" is corroborated, so the old bias behaviour is kept deliberately.
    mockNominatim([
      { lat: -37.81, lon: 144.96, importance: 0.45 },
      { lat: -33.90, lon: 151.10, importance: 0.35 },
    ]);
    expect(await geocode("Kilsyth, VIC", "au", SYDNEY)).not.toBeNull();
  });

  it("does not apply the guard when there is no bias origin at all", async () => {
    mockNominatim([{ lat: -27.50, lon: 153.20, importance: 0.45 }]);
    expect(await geocode("Birkdale unbiased")).not.toBeNull();
  });
});
