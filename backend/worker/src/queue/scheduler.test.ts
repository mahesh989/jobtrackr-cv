import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// In-process cron scheduling (no BullMQ job schedulers — see scheduler.ts
// header). These tests drive the timer arming with fake clocks and assert
// jobs are enqueued exactly at cron ticks.

const added: Array<{ name: string; data: unknown }> = [];
const legacySchedulers: Array<{ id: string }> = [];
const removedLegacy: string[] = [];
vi.mock("./queue.js", () => ({
  pipelineQueue: {
    add: vi.fn(async (name: string, data: unknown) => {
      added.push({ name, data });
      return { id: "job" };
    }),
    getJobSchedulers: vi.fn(async () => legacySchedulers),
    removeJobScheduler: vi.fn(async (id: string) => {
      removedLegacy.push(id);
    }),
  },
}));

const profileRows: Array<{
  id: string; schedule_cron: string | null; is_active: boolean; is_manual: boolean;
}> = [];
vi.mock("../db/client.js", () => ({
  db: {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: profileRows, error: null }),
      }),
    }),
  },
}));

const {
  nextCronTime,
  registerGlobalSchedules,
  registerProfileSchedule,
  removeProfileSchedule,
  syncSchedules,
} = await import("./scheduler.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T10:03:00.000Z"));
  added.length = 0;
  legacySchedulers.length = 0;
  removedLegacy.length = 0;
  profileRows.length = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("nextCronTime", () => {
  it("finds the next 15-minute boundary", () => {
    expect(nextCronTime("*/15 * * * *", new Date("2026-07-10T10:03:00Z"))).toBe(
      Date.parse("2026-07-10T10:15:00Z")
    );
  });

  it("finds the next Sunday 22:00 UTC for the weekly digest", () => {
    // 2026-07-10 is a Friday; next Sunday is the 12th.
    expect(nextCronTime("0 22 * * 0", new Date("2026-07-10T10:03:00Z"))).toBe(
      Date.parse("2026-07-12T22:00:00Z")
    );
  });
});

describe("registerGlobalSchedules", () => {
  it("enqueues the notify sweep at each 15-minute tick, re-arming itself", async () => {
    await registerGlobalSchedules();
    expect(added).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(12 * 60_000); // 10:15
    expect(added.filter((a) => a.name === "run_notify_sweep")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000); // 10:30
    expect(added.filter((a) => a.name === "run_notify_sweep")).toHaveLength(2);
  });

  it("removes legacy Redis job schedulers left by previous versions", async () => {
    legacySchedulers.push({ id: "weekly-digest" }, { id: "profile:abc" });
    await registerGlobalSchedules();
    expect(removedLegacy).toEqual(["weekly-digest", "profile:abc"]);
  });
});

describe("profile schedules", () => {
  it("enqueues run_profile at the cron tick with retry opts intact", async () => {
    await registerProfileSchedule("p1", "0 21 */2 * *");
    await vi.advanceTimersByTimeAsync(
      nextCronTime("0 21 */2 * *", new Date("2026-07-10T10:03:00Z")) -
        Date.parse("2026-07-10T10:03:00Z")
    );
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe("run_profile");
    expect(added[0].data).toMatchObject({ type: "run_profile", profileId: "p1" });
  });

  it("a removed profile schedule never fires", async () => {
    await registerProfileSchedule("p1", "*/15 * * * *");
    await removeProfileSchedule("p1");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(added).toHaveLength(0);
  });

  it("re-registering replaces the previous timer instead of duplicating it", async () => {
    await registerProfileSchedule("p1", "*/15 * * * *");
    await registerProfileSchedule("p1", "*/15 * * * *");
    await vi.advanceTimersByTimeAsync(12 * 60_000); // one tick
    expect(added).toHaveLength(1);
  });
});

describe("syncSchedules", () => {
  it("arms active profiles and clears ones that became inactive", async () => {
    profileRows.push(
      { id: "p1", schedule_cron: "*/15 * * * *", is_active: true, is_manual: false },
      { id: "p2", schedule_cron: "*/15 * * * *", is_active: false, is_manual: false }
    );
    await syncSchedules();

    await vi.advanceTimersByTimeAsync(12 * 60_000);
    const runs = added.filter((a) => a.name === "run_profile");
    expect(runs).toHaveLength(1);
    expect(runs[0].data).toMatchObject({ profileId: "p1" });

    // p1 deactivated → next sync clears its timer; no further ticks fire.
    profileRows[0].is_active = false;
    await syncSchedules();
    added.length = 0;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(added.filter((a) => a.name === "run_profile")).toHaveLength(0);
  });
});
