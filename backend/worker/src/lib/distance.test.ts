import { describe, it, expect, vi, afterEach } from "vitest";
import { extractAuState, AU_STATE_RE, geocode, isLocalityResult } from "./distance.js";

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

// ── The locality guard ─────────────────────────────────────────────────────
// Fixtures are REAL Nominatim responses, captured 2026-08-08 for a Sydney-
// biased search. They matter because the first version of this guard was built
// on a wrong assumption — that the real, distant suburb comes back alongside
// the local one so a "wrong winner" could be detected. It does not: the
// viewbox biases the RESULT SET, so "Greenbank" returns nine Sydney streets
// and the Queensland original never appears. What actually separates them is
// the feature class.
describe("geocode locality guard", () => {
  const SYDNEY = { lat: -33.87, lng: 151.21 };

  function mockNominatim(results: Array<Record<string, unknown>>) {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => results }));
  }
  afterEach(() => vi.unstubAllGlobals());

  it("drops a bare suburb that resolves to a STREET (the real Greenbank case)", async () => {
    mockNominatim([
      { lat: "-33.93", lon: "151.15", importance: 0,     class: "building", type: "apartments" },
      { lat: "-33.75", lon: "150.74", importance: 0.053, class: "highway",  type: "tertiary" },
    ]);
    expect(await geocode("Greenbank", "au", SYDNEY)).toBeNull();
  });

  it("drops a bare suburb that resolves to a LAND PARCEL (the real Birkdale case)", async () => {
    // The single candidate Nominatim actually returns — note it is in-box and
    // unopposed, so no ranking-based check could ever have caught this.
    mockNominatim([
      { lat: "-33.94", lon: "151.20", importance: 0.080, class: "landuse", type: "residential" },
    ]);
    expect(await geocode("Birkdale", "au", SYDNEY)).toBeNull();
  });

  it("keeps a real suburb (boundary/administrative)", async () => {
    mockNominatim([
      { lat: "-33.88", lon: "151.08", importance: 0.235, class: "boundary", type: "administrative" },
    ]);
    const hit = await geocode("Strathfield South", "au", SYDNEY);
    expect(hit).not.toBeNull();
    expect(hit!.lat).toBeCloseTo(-33.88, 2);
  });

  it("keeps a place-class node", async () => {
    mockNominatim([{ lat: "-33.89", lon: "151.24", importance: 0.4, class: "place", type: "suburb" }]);
    expect(await geocode("Randwick place-node", "au", SYDNEY)).not.toBeNull();
  });

  it("trusts a state-qualified string even when it resolves to a street", async () => {
    // Corroborated by the state, so the old behaviour is kept deliberately —
    // this is the path extractAuState upgrades jobs INTO.
    mockNominatim([{ lat: "-27.50", lon: "153.20", importance: 0.05, class: "highway", type: "residential" }]);
    expect(await geocode("Birkdale, QLD", "au", SYDNEY)).not.toBeNull();
  });

  it("does not drop when class/type are absent (guard acts only on positive evidence)", async () => {
    mockNominatim([{ lat: "-33.88", lon: "151.10", importance: 0.3 }]);
    expect(await geocode("Shape-less response", "au", SYDNEY)).not.toBeNull();
  });
});

describe("isLocalityResult", () => {
  it("accepts gazetted places, rejects same-named features", () => {
    expect(isLocalityResult({ class: "boundary", type: "administrative" })).toBe(true);
    expect(isLocalityResult({ class: "place", type: "town" })).toBe(true);
    expect(isLocalityResult({ class: "highway", type: "tertiary" })).toBe(false);
    expect(isLocalityResult({ class: "building", type: "apartments" })).toBe(false);
    expect(isLocalityResult({ class: "landuse", type: "residential" })).toBe(false);
    expect(isLocalityResult({})).toBe(true);   // no evidence -> do not drop
  });
});
