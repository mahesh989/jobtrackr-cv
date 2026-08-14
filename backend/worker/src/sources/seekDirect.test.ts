/**
 * Regression test for #21 (audit, execution chunk C28): normaliseSeekLocation
 * stripped a trailing ", Australia" / " Australia" suffix BEFORE checking
 * the AU-wide sentinel values — so any real AU state name that happens to
 * END in the word "Australia" got mangled too: "Western Australia" ->
 * "Western", "South Australia" -> "South". Worse, "All Australia" ->
 * "All" ran through the SAME strip before the sentinel check, so the
 * `all australia` branch (meant to signal "no where param, search all of
 * AU") was completely unreachable — no input could ever reach it.
 *
 * Fix: check the AU-wide sentinels and the two state names ending in
 * "Australia" against the ORIGINAL string, before any stripping.
 */
import { describe, it, expect } from "vitest";
import { normaliseSeekLocation } from "./seekDirect.js";

describe("normaliseSeekLocation", () => {
  it("preserves real AU state names that end in the word Australia", () => {
    expect(normaliseSeekLocation("Western Australia")).toBe("Western Australia");
    expect(normaliseSeekLocation("South Australia")).toBe("South Australia");
  });

  it("is case-insensitive for the state-name preservation too", () => {
    expect(normaliseSeekLocation("western australia")).toBe("western australia");
  });

  it("the All Australia sentinel is reachable and returns empty (AU-wide search)", () => {
    expect(normaliseSeekLocation("All Australia")).toBe("");
    expect(normaliseSeekLocation("all australia")).toBe("");
  });

  it("bare Australia is also an AU-wide sentinel", () => {
    expect(normaliseSeekLocation("Australia")).toBe("");
  });

  it("still strips a redundant trailing Australia suffix a user appends", () => {
    expect(normaliseSeekLocation("Sydney, Australia")).toBe("Sydney");
    expect(normaliseSeekLocation("Sydney Australia")).toBe("Sydney");
  });

  it("leaves an ordinary city/state location with no Australia suffix untouched", () => {
    expect(normaliseSeekLocation("Sydney NSW")).toBe("Sydney NSW");
    expect(normaliseSeekLocation("New South Wales")).toBe("New South Wales");
  });

  it("returns empty for empty input", () => {
    expect(normaliseSeekLocation("")).toBe("");
    expect(normaliseSeekLocation("   ")).toBe("");
  });
});
