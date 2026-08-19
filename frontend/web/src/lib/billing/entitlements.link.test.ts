import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C67: linkUsageEvent's update result — including any error — was discarded
 * entirely, unlike its siblings releaseUsageEvent/commitUsageEvent (see
 * entitlements.run.test.ts) which both check and throw. A silent failure
 * here left a reservation stuck "pending" with no ref_id forever: the
 * commit/void trigger keys off ref_id, and pending reservations count
 * toward the usage cap — so it silently, permanently burns a credit.
 */
const db = vi.hoisted(() => {
  const eq = vi.fn();
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { eq, update, from };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: db.from }),
}));

import { linkUsageEvent } from "./entitlements";

describe("linkUsageEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves silently when the ref_id write succeeds", async () => {
    db.eq.mockResolvedValue({ error: null });
    await expect(linkUsageEvent("evt-1", "run-1")).resolves.toBeUndefined();
    expect(db.from).toHaveBeenCalledWith("usage_events");
    expect(db.update).toHaveBeenCalledWith({ ref_id: "run-1" });
    expect(db.eq).toHaveBeenCalledWith("id", "evt-1");
  });

  it("throws instead of silently leaving the reservation stuck pending when the write fails", async () => {
    db.eq.mockResolvedValue({ error: { message: "connection reset" } });
    await expect(linkUsageEvent("evt-1", "run-1")).rejects.toThrow("connection reset");
  });
});
