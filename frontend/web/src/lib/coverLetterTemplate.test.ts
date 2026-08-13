/**
 * Regression test for #60 (audit, execution chunk C77): assembleLetter()
 * dated every cover letter using `toLocaleDateString("en-AU", {...})` with
 * no `timeZone`. The locale controls FORMATTING (day/month order, month
 * names) but not which calendar day is used — that comes from the
 * runtime's default timezone, which on this repo's Vercel/Fly deployment
 * is UTC, not Australia/Sydney. Since AU is UTC+10/+11, a letter generated
 * during the first ~10-11 hours of the Australian day was dated ONE DAY
 * EARLY (it printed yesterday's date, in UTC, instead of today's, in AU).
 *
 * Two other places in this repo already pass `timeZone: "Australia/Sydney"`
 * explicitly for exactly this reason (admin/page.tsx, admin/metrics/page.tsx).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assembleLetter } from "./coverLetterTemplate";
import type { ContactDetails } from "./types";

const contactDetails: ContactDetails = { name: "Jordan Lee", email: "jordan@example.com" };

function letterDateLine(): string {
  const letter = assembleLetter({
    contactDetails,
    company: "Acme Health",
    companyAddress: null,
    companyLocation: "Sydney NSW",
    hiringManager: null,
    body: "Body text.",
  });
  // Date is the first non-empty line after the contact block.
  const lines = letter.split("\n");
  const blankIdx = lines.indexOf("");
  return lines[blankIdx + 1];
}

describe("assembleLetter — date must use the Australian calendar day, not the server's local timezone", () => {
  const originalTZ = process.env.TZ;

  beforeEach(() => {
    // Reproduce the deployed environment (Vercel/Fly run in UTC).
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTZ;
  });

  it("REGRESSION (#60): does not date the letter a day early during the first 10 hours of the AU day", () => {
    // 2026-08-13T20:00:00Z = 2026-08-14 06:00 AEST (Sydney is UTC+10 in
    // August — outside AEDT). The real Australian date is the 14th.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T20:00:00.000Z"));

    const dateLine = letterDateLine();

    expect(dateLine).toBe("14 August 2026");
  });

  it("still renders correctly for a time safely inside the AU business day", () => {
    // 2026-08-14T04:00:00Z = 2026-08-14 14:00 AEST — same calendar day
    // whether formatted in UTC or Sydney time, so this passed even before
    // the fix. Kept as a non-regression control case.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T04:00:00.000Z"));

    const dateLine = letterDateLine();

    expect(dateLine).toBe("14 August 2026");
  });
});
