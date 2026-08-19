/**
 * Regression test for #60 (audit, execution chunk C77): scheduleLabel()
 * matched the "Daily" case with a substring test on the cron interval
 * marker — that marker is a prefix of the 10-19 day interval markers too,
 * so it also matched those, rendering 10 of the 30 selectable auto-run
 * intervals as "Daily" instead of "Every N days". Proved by execution
 * across the full 1-30 day range that profiles/[id]/edit's `autoDays`
 * slider allows (lib/actions/profiles.ts clamps to
 * Math.min(30, Math.max(1, ...))).
 */
import { describe, it, expect } from "vitest";
import { scheduleLabel } from "./ProfilesTable";

describe("scheduleLabel", () => {
  it("REGRESSION (#60): labels every 1-30 day interval correctly, not just single-digit ones", () => {
    for (let n = 1; n <= 30; n++) {
      const cron = `0 21 */${n} * *`;
      const expected = n === 1 ? "Daily" : `Every ${n} days`;
      expect(scheduleLabel(cron)).toBe(expected);
    }
  });

  it("still labels the legacy bare fixed-daily pattern as Daily", () => {
    expect(scheduleLabel("0 21 * * *")).toBe("Daily");
  });

  it("still labels weekly patterns and manual/empty schedules correctly", () => {
    expect(scheduleLabel("")).toBe("Manual");
    expect(scheduleLabel("0 21 * * 1")).toBe("Weekly Mon");
    expect(scheduleLabel("0 21 * * 3")).toBe("Weekly Wed");
    expect(scheduleLabel("0 21 * * 5")).toBe("Weekly Fri");
  });
});
