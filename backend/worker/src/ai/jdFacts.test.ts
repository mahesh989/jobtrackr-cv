import { describe, it, expect } from "vitest";
import {
  mapStructuredWorkType,
  extractEmploymentTypes,
  extractEmails,
  bestApplicationEmail,
  extractTextSalary,
  extractClosingDate,
  extractShiftPatterns,
  detectAgency,
} from "./jdFacts.js";

describe("mapStructuredWorkType", () => {
  it("maps SEEK's four canonical work types", () => {
    expect(mapStructuredWorkType("Full time")).toEqual(["full_time"]);
    expect(mapStructuredWorkType("Part time")).toEqual(["part_time"]);
    expect(mapStructuredWorkType("Casual/Vacation")).toEqual(["casual"]);
    expect(mapStructuredWorkType("Contract/Temp")).toEqual(["contract", "temporary"]);
  });

  it("maps Adzuna contract_time/contract_type values", () => {
    expect(mapStructuredWorkType("full_time")).toEqual(["full_time"]);
    expect(mapStructuredWorkType("part_time")).toEqual(["part_time"]);
    expect(mapStructuredWorkType("contract")).toEqual(["contract"]);
    expect(mapStructuredWorkType("permanent")).toEqual([]); // no hours info
  });

  it("maps Ashby employmentType values (camelcase and hyphenated)", () => {
    expect(mapStructuredWorkType("FullTime")).toEqual(["full_time"]);
    expect(mapStructuredWorkType("Full-Time")).toEqual(["full_time"]);
    expect(mapStructuredWorkType("Intern")).toEqual(["internship"]);
  });
});

describe("extractEmploymentTypes", () => {
  it("structured metadata wins and sets provenance", () => {
    const r = extractEmploymentTypes({
      title: "Registered Nurse",
      description: "casual position", // would regex-match casual
      employment_types_raw: ["Full time"],
    });
    expect(r).toEqual({ types: ["full_time"], source: "structured" });
  });

  it("falls back to regex over title+description", () => {
    const r = extractEmploymentTypes({
      title: "AIN — Aged Care",
      description: "This is a permanent part-time role, 3 days per week.",
    });
    expect(r.types).toEqual(["part_time"]);
    expect(r.source).toBe("regex");
  });

  it("collects multiple offered types", () => {
    const r = extractEmploymentTypes({
      title: "RN",
      description: "Available as Full-time or Part-time. Casual pool also open.",
    });
    expect(r.types).toEqual(["full_time", "part_time", "casual"]);
  });

  it("understands AU shorthand: PPT and fractional FTE", () => {
    expect(
      extractEmploymentTypes({ title: "EN", description: "PPT position available now" }).types
    ).toEqual(["part_time"]);
    expect(
      extractEmploymentTypes({ title: "RN", description: "This role is 0.6 FTE ongoing" }).types
    ).toEqual(["part_time"]);
    expect(
      extractEmploymentTypes({ title: "RN", description: "1.0 FTE permanent role" }).types
    ).toEqual(["full_time"]);
  });

  it("detects fixed-term/contract phrasing", () => {
    expect(
      extractEmploymentTypes({ title: "RN", description: "12-month contract, parental leave cover" }).types
    ).toEqual(["contract"]);
  });

  it("returns empty with null source when nothing is stated", () => {
    expect(
      extractEmploymentTypes({ title: "Registered Nurse", description: "Join our team in Sydney." })
    ).toEqual({ types: [], source: null });
  });
});

describe("extractEmails", () => {
  it("classifies an application email", () => {
    const r = extractEmails(
      "To apply, send your resume and cover letter to recruitment@carehome.com.au by Friday."
    );
    expect(r).toHaveLength(1);
    expect(r[0].email).toBe("recruitment@carehome.com.au");
    expect(r[0].kind).toBe("application");
  });

  it("classifies an enquiry email with the contact person", () => {
    const r = extractEmails(
      "For a confidential discussion contact Jane Smith at jane.smith@agency.com.au or call 0400 000 000."
    );
    expect(r[0].kind).toBe("enquiry");
    expect(r[0].person).toBe("Jane Smith");
  });

  it("application beats enquiry when both signals share a sentence", () => {
    const r = extractEmails(
      "Send applications to jobs@hospital.org.au or contact us with any questions."
    );
    expect(r[0].kind).toBe("application");
  });

  it("drops noreply/privacy noise and dedupes", () => {
    const r = extractEmails(
      "Apply at hr@x.com.au. Questions? hr@x.com.au. Do not reply to noreply@x.com.au. See privacy@x.com.au."
    );
    expect(r).toHaveLength(1);
    expect(r[0].email).toBe("hr@x.com.au");
  });

  it("returns [] for JDs without emails", () => {
    expect(extractEmails("Great team, apply via our website.")).toEqual([]);
  });

  it("bestApplicationEmail picks only application-kind", () => {
    const emails = extractEmails(
      "For enquiries contact info@x.com.au. Send your CV to apply@x.com.au."
    );
    expect(bestApplicationEmail(emails)).toBe("apply@x.com.au");
    expect(bestApplicationEmail(extractEmails("Questions? info@x.com.au"))).toBeNull();
  });
});

describe("extractTextSalary", () => {
  it("parses an hourly range with period", () => {
    expect(extractTextSalary("Pay: $34.50 - $42.10 per hour + super")).toEqual({
      min: 34.5, max: 42.1, period: "hour",
    });
  });

  it("parses annual k-ranges", () => {
    expect(extractTextSalary("Salary $85k – $95k p.a. plus benefits")).toEqual({
      min: 85_000, max: 95_000, period: "year",
    });
  });

  it("parses a single 'circa' figure with comma thousands", () => {
    expect(extractTextSalary("circa $90,000 per year")).toEqual({
      min: 90_000, max: null, period: "year",
    });
  });

  it("infers hourly for small magnitudes with no stated period", () => {
    expect(extractTextSalary("Rate: $45.00 + penalties")).toEqual({
      min: 45, max: null, period: "hour",
    });
  });

  it("refuses ambiguous magnitudes and misparses", () => {
    expect(extractTextSalary("a $500 sign-on bonus")).toBeNull();     // 200-10k no period
    expect(extractTextSalary("no dollar figures here")).toBeNull();
  });
});

describe("extractClosingDate", () => {
  const now = new Date("2026-07-11T00:00:00Z");

  it("parses wordy AU dates with and without year", () => {
    expect(extractClosingDate("Applications close 25 July 2026.", now)).toBe("2026-07-25");
    expect(extractClosingDate("Applications close on 25th of July.", now)).toBe("2026-07-25");
  });

  it("rolls a past yearless date into next year", () => {
    expect(extractClosingDate("Applications close 5 January.", now)).toBe("2027-01-05");
  });

  it("parses numeric AU day-first dates", () => {
    expect(extractClosingDate("Closing date: 25/07/2026", now)).toBe("2026-07-25");
  });

  it("ignores dates without a closing context", () => {
    expect(extractClosingDate("Founded on 25 July 1990, we are a leading provider.", now)).toBeNull();
  });
});

describe("extractShiftPatterns", () => {
  it("finds healthcare shift tags", () => {
    expect(
      extractShiftPatterns("AM shifts and PM shifts available, night duty shift on a 7-day rotating roster with sleepovers.")
    ).toEqual(expect.arrayContaining(["morning", "afternoon", "night", "rotating_roster", "sleepover"]));
  });

  it("returns [] when no shift language", () => {
    expect(extractShiftPatterns("Standard business hours role.")).toEqual([]);
  });
});

describe("detectAgency", () => {
  it("flags recruiter phrasing in the JD", () => {
    expect(detectAgency("Acme Talent", "Our client, a leading aged care provider, is seeking…")).toBe(true);
  });

  it("flags known AU agencies by company name", () => {
    expect(detectAgency("Healthcare Australia", "Great nursing role")).toBe(true);
  });

  it("returns null (unknown), never false", () => {
    expect(detectAgency("Uniting NSW", "Join our team directly.")).toBeNull();
  });
});
