import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const rpc = vi.fn();
  const update = vi.fn();
  const updateEq2 = vi.fn();
  const updateEq1 = vi.fn(() => ({ eq: updateEq2 }));
  const from = vi.fn();
  return { rpc, update, updateEq1, updateEq2, from };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: db.rpc, from: db.from }),
}));

import {
  commitRunUsageEvent,
  commitUsageEvent,
  consumeRun,
  releaseUsageEvent,
} from "./entitlements";

function readableRow(data: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

describe("run usage reservation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.rpc.mockResolvedValue({
      data: [{ allowed: true, reason: "ok", event_id: "evt-run-1" }],
      error: null,
    });
    db.updateEq2.mockResolvedValue({ error: null });
    db.update.mockReturnValue({ eq: db.updateEq1 });
    db.from.mockImplementation((table: string) => {
      if (table === "users") return readableRow({ role: "beta" });
      if (table === "subscriptions") {
        return readableRow({
          plan_id: "weekly",
          status: "active",
          current_period_start: "2026-08-11T00:00:00.000Z",
          current_period_end: "2026-08-18T00:00:00.000Z",
          trial_end: null,
        });
      }
      if (table === "plans") {
        return readableRow({
          max_profiles: 5,
          max_runs: 30,
          max_cv_unique: 50,
          max_cv_total: 75,
          max_letter_unique: 50,
          max_letter_total: 75,
        });
      }
      if (table === "usage_events") return { update: db.update };
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("reserves a metered run without committing it before enqueue succeeds", async () => {
    await expect(consumeRun(
      "user-1",
      "11111111-1111-4111-8111-111111111111",
      "profile-1",
      false,
    )).resolves.toEqual({
      allowed: true,
      eventId: "evt-run-1",
    });

    expect(db.rpc).toHaveBeenCalledWith("reserve_run_usage", expect.objectContaining({
      p_user: "user-1",
      p_request: "11111111-1111-4111-8111-111111111111",
      p_profile: "profile-1",
      p_full_refresh: false,
    }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ["commit", commitUsageEvent],
    ["release", releaseUsageEvent],
  ])("throws when a usage %s write fails", async (_label, write) => {
    db.updateEq2.mockResolvedValue({ error: { message: "write failed" } });

    await expect(write("evt-run-1")).rejects.toThrow("write failed");
  });

  it("treats reservation transport errors as uncertain and verifies run commits", async () => {
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: "ack lost" } });
    await expect(
      consumeRun(
        "user-1",
        "11111111-1111-4111-8111-111111111111",
        "profile-1",
        false,
      ),
    ).rejects.toThrow("reservation uncertain");

    db.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(commitRunUsageEvent("evt-run-1")).rejects.toThrow("not pending or committed");

    db.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(commitRunUsageEvent("evt-run-1")).resolves.toBeUndefined();
  });
});
