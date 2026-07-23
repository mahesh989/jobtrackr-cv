import { describe, it, expect, vi } from "vitest";

// decideGate/groupByUser are pure, but gate.ts and newJobsSweep.ts also
// import the service-role db client + scheduler + resend at module scope —
// mock those so this suite can run without live Supabase/Redis/Resend env
// vars, same pattern as errorAlert.test.ts.
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../queue/scheduler.js", () => ({ removeProfileSchedule: vi.fn() }));
vi.mock("resend", () => ({ Resend: vi.fn() }));
vi.mock("./engagementEmails.js", () => ({
  sendInactivityWarningEmail: vi.fn(),
  sendPausedEmail: vi.fn(),
  sendNewJobsEmail: vi.fn(),
}));

const { decideGate, WARN_AFTER_DAYS, PAUSE_AFTER_DAYS, TRIAL_GRACE_HOURS } = await import("./gate.js");
const { groupByUser } = await import("./newJobsSweep.js");

const NOW = new Date("2026-07-10T00:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}
function hoursFromNow(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
}

describe("decideGate — activity", () => {
  it("fresh user (seen now) -> run", () => {
    const result = decideGate(NOW, { last_seen_at: daysAgo(0), inactivity_warned_at: null }, null);
    expect(result).toEqual({ action: "run" });
  });

  it("15d inactive, never warned -> warn_and_run", () => {
    const result = decideGate(NOW, { last_seen_at: daysAgo(15), inactivity_warned_at: null }, null);
    expect(result).toEqual({ action: "warn_and_run" });
  });

  it("15d inactive, warned after last_seen -> run (no re-warn)", () => {
    const lastSeen = daysAgo(15);
    const warnedAt = daysAgo(1); // after last_seen
    const result = decideGate(NOW, { last_seen_at: lastSeen, inactivity_warned_at: warnedAt }, null);
    expect(result).toEqual({ action: "run" });
  });

  it("returned after warn, then idle 15d again (warned_at < last_seen_at) -> warn_and_run", () => {
    const warnedAt = daysAgo(40); // old warning
    const lastSeen = daysAgo(15); // user returned, then went idle again
    const result = decideGate(NOW, { last_seen_at: lastSeen, inactivity_warned_at: warnedAt }, null);
    expect(result).toEqual({ action: "warn_and_run" });
  });

  it("30d inactive -> pause inactivity (even if warned)", () => {
    const result = decideGate(
      NOW,
      { last_seen_at: daysAgo(30), inactivity_warned_at: daysAgo(16) },
      null,
    );
    expect(result).toEqual({ action: "pause", reason: "inactivity" });
  });

  it("engagement null -> run", () => {
    const result = decideGate(NOW, null, null);
    expect(result).toEqual({ action: "run" });
  });

  it(`exactly at WARN_AFTER_DAYS (${WARN_AFTER_DAYS}d) -> warn_and_run`, () => {
    const result = decideGate(NOW, { last_seen_at: daysAgo(WARN_AFTER_DAYS), inactivity_warned_at: null }, null);
    expect(result).toEqual({ action: "warn_and_run" });
  });

  it(`exactly at PAUSE_AFTER_DAYS (${PAUSE_AFTER_DAYS}d) -> pause inactivity`, () => {
    const result = decideGate(NOW, { last_seen_at: daysAgo(PAUSE_AFTER_DAYS), inactivity_warned_at: null }, null);
    expect(result).toEqual({ action: "pause", reason: "inactivity" });
  });
});

describe("decideGate — subscription precedence", () => {
  it("31d inactive + dead sub -> pause subscription (subscription takes precedence)", () => {
    const result = decideGate(
      NOW,
      { last_seen_at: daysAgo(31), inactivity_warned_at: null },
      { status: "canceled", trial_end: null },
    );
    expect(result).toEqual({ action: "pause", reason: "subscription" });
  });

  for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
    it(`dead status "${status}" -> pause subscription even when seen today`, () => {
      const result = decideGate(
        NOW,
        { last_seen_at: daysAgo(0), inactivity_warned_at: null },
        { status, trial_end: null },
      );
      expect(result).toEqual({ action: "pause", reason: "subscription" });
    });
  }

  it("trialing with trial_end 2 days ago -> pause subscription", () => {
    const result = decideGate(
      NOW,
      { last_seen_at: daysAgo(0), inactivity_warned_at: null },
      { status: "trialing", trial_end: daysAgo(2) },
    );
    expect(result).toEqual({ action: "pause", reason: "subscription" });
  });

  it("trialing with trial_end in the future -> run", () => {
    const result = decideGate(
      NOW,
      { last_seen_at: daysAgo(0), inactivity_warned_at: null },
      { status: "trialing", trial_end: hoursFromNow(48) },
    );
    expect(result).toEqual({ action: "run" });
  });

  it(`trialing trial_end 12h ago (inside ${TRIAL_GRACE_HOURS}h grace) -> run`, () => {
    const result = decideGate(
      NOW,
      { last_seen_at: daysAgo(0), inactivity_warned_at: null },
      { status: "trialing", trial_end: hoursAgo(12) },
    );
    expect(result).toEqual({ action: "run" });
  });

  for (const status of ["past_due", "comp", "active", "incomplete"]) {
    it(`status "${status}" -> not paused by subscription`, () => {
      const result = decideGate(
        NOW,
        { last_seen_at: daysAgo(0), inactivity_warned_at: null },
        { status, trial_end: null },
      );
      expect(result).toEqual({ action: "run" });
    });
  }

  it("missing subscription row -> not paused by subscription", () => {
    const result = decideGate(NOW, { last_seen_at: daysAgo(0), inactivity_warned_at: null }, null);
    expect(result).toEqual({ action: "run" });
  });
});

describe("groupByUser (newJobsSweep pure helper)", () => {
  it("groups rows by user_id, preserving order within each group", () => {
    const rows = [
      { id: "1", user_id: "u1", profile_id: "p1", profile_name: "A", jobs_saved: 3, created_at: "" },
      { id: "2", user_id: "u2", profile_id: "p2", profile_name: "B", jobs_saved: 1, created_at: "" },
      { id: "3", user_id: "u1", profile_id: "p3", profile_name: "C", jobs_saved: 2, created_at: "" },
    ];
    const grouped = groupByUser(rows);
    expect(grouped.size).toBe(2);
    expect(grouped.get("u1")).toHaveLength(2);
    expect(grouped.get("u1")?.map((r) => r.id)).toEqual(["1", "3"]);
    expect(grouped.get("u2")).toHaveLength(1);
  });

  it("empty input -> empty map", () => {
    expect(groupByUser([]).size).toBe(0);
  });
});
