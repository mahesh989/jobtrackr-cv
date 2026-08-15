import { describe, it, expect } from "vitest";
import { parseSalary } from "./seek.js";

// Regression cover for C29 (AUDIT-REPORT.md #22): parseSalary used to take the
// first two numbers in the label with no period scaling beyond hourly and no
// sanity guard, so it silently pre-empted ai/jdFacts.ts's sanity-checked
// extractTextSalary fallback (both callers only run the fallback when
// salary_min is still null) and wrote garbage straight into the shared global
// bucket. Table transcribed from the audit's own `node -e` reproduction.

describe("parseSalary", () => {
  it("returns {} for no text", () => {
    expect(parseSalary(undefined)).toEqual({});
    expect(parseSalary(null)).toEqual({});
    expect(parseSalary("")).toEqual({});
  });

  it("parses a plain annual range", () => {
    expect(parseSalary("$90,000 - $110,000")).toEqual({ salary_min: 90000, salary_max: 110000 });
  });

  it("REGRESSION: excludes a trailing super/loading percentage from the candidate pool instead of treating it as salary_max", () => {
    // Was {salary_min:120000, salary_max:11.5} — rendered as "$120k–$11.5" on
    // the board chip. The base salary is still real and worth keeping; only
    // the bogus 11.5%-as-max is wrong, so it's excluded rather than the whole
    // pair dropped.
    expect(parseSalary("$120,000 + 11.5% Super")).toEqual({ salary_min: 120000, salary_max: 120000 });
  });

  it("does not let a percentage figure disturb a genuine two-number range", () => {
    // The "+11.5% super" earlier in this repo's own real-world example
    // happened to land on the correct range by accident (super was the THIRD
    // number). Confirm the % exclusion doesn't regress it.
    expect(parseSalary("$110,000 - $130,000 + 11.5% super + bonus"))
      .toEqual({ salary_min: 110000, salary_max: 130000 });
  });

  it("REGRESSION: annualises a daily rate instead of storing the daily figure as-is", () => {
    // Was {salary_min:1200, salary_max:1200} — a ~$312k/yr contractor role
    // stored and sorted as the lowest-paid job on the board.
    expect(parseSalary("$1,200 per day + super")).toEqual({ salary_min: 312000, salary_max: 312000 });
  });

  it("REGRESSION: annualises a monthly rate", () => {
    expect(parseSalary("$8,000 per month")).toEqual({ salary_min: 96000, salary_max: 96000 });
  });

  it("REGRESSION: annualises a weekly rate", () => {
    expect(parseSalary("$2,500 per week")).toEqual({ salary_min: 130000, salary_max: 130000 });
  });

  it("REGRESSION: recognises the abbreviated 'p.h.' hourly form, not just 'per hour'/'hourly'/'/hr'", () => {
    // Was {salary_min:35.5, salary_max:35.5} — "p.h." wasn't in the hourly
    // regex at all, so the rate was stored unscaled.
    expect(parseSalary("$35.50 p.h. + penalties")).toEqual({ salary_min: 73840, salary_max: 73840 });
  });

  it("still recognises the original hourly forms", () => {
    expect(parseSalary("$45 per hour")).toEqual({ salary_min: 93600, salary_max: 93600 });
    expect(parseSalary("$45 hourly")).toEqual({ salary_min: 93600, salary_max: 93600 });
    expect(parseSalary("$45/hr")).toEqual({ salary_min: 93600, salary_max: 93600 });
  });

  it("sanity guard: a max below the min (misparse) falls back to min rather than reporting a negative-width range", () => {
    expect(parseSalary("$50,000 - $10")).toEqual({ salary_min: 50000, salary_max: 50000 });
  });

  it("known residual, not fixed by this chunk (accepted, see EXECUTION-LOG.md [C29]): a packaging-cap figure ahead of the real base salary is still misread", () => {
    // Fixing this needs semantic understanding of "packaging up to X + Y
    // base" phrasing, out of scope for the two sanity/period guards this
    // chunk adds. Documented so a future reader doesn't assume it's fixed.
    expect(parseSalary("Salary packaging up to $18,550 + $95,000 base"))
      .toEqual({ salary_min: 18550, salary_max: 95000 });
  });
});
