import { describe, it, expect } from "vitest";
import { companiesMatch, normaliseCompany, normaliseCity } from "./keys.js";

describe("companiesMatch", () => {
  it("matches when one normalised name is a prefix of the other", () => {
    expect(companiesMatch("ing", "ing bank")).toBe(true);
  });

  it("does not match unrelated companies", () => {
    expect(companiesMatch("ing", "kfc")).toBe(false);
  });

  it("never matches when either side is empty", () => {
    expect(companiesMatch("", "kfc")).toBe(false);
    expect(companiesMatch("ing", "")).toBe(false);
  });
});

describe("normaliseCompany", () => {
  it("reduces entity-suffixed names to the same core as the bare name", () => {
    expect(normaliseCompany("ING Bank Limited")).toBe("ing bank");
    expect(normaliseCompany("ING")).toBe("ing");
  });

  it("strips locale and recruiter-noise tokens", () => {
    expect(normaliseCompany("TAL Australia")).toBe("tal");
    expect(normaliseCompany("FourQuarters Recruitment")).toBe("fourquarters");
  });
});

describe("normaliseCity", () => {
  it("extracts the AU metro from a noisy location string", () => {
    expect(normaliseCity("The Rocks, Sydney")).toBe("sydney");
  });

  it("falls back to the state code when no metro is present", () => {
    expect(normaliseCity("Frenchs Forest NSW")).toBe("nsw");
  });

  it("returns empty string when neither metro nor state is found", () => {
    expect(normaliseCity("All Australia")).toBe("");
  });
});
