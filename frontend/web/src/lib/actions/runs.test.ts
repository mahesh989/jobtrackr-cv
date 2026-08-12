/**
 * Regression test for #46 (audit): `cancelRun` verified ownership of
 * `profileId` against `search_profiles`, then mutated a DIFFERENT table
 * (`run_logs`) keyed only on `runId` via the service-role client, with no
 * `.eq("profile_id", profileId)` filter. Any authenticated user could pass
 * one of their OWN profileIds (passes the ownership check) together with
 * another tenant's `run_logs.id` and cancel that user's running pipeline —
 * a cross-tenant write reachable through the Server Action's public POST
 * endpoint (`cancelRun.bind(null, run.id, id)` is not a security boundary).
 *
 * `run_logs` has no RLS UPDATE policy (see the comment in runs.ts), so the
 * admin client bypasses row-level security entirely — the query itself is
 * the only defense. This test asserts the query built by `cancelRun`
 * carries the `profile_id` filter, using a recording fake for the
 * service-role client (matching this repo's convention of testing pure/
 * injectable logic rather than mocking the real Supabase client).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authedClientMock = vi.fn();
vi.mock("./_helpers", () => ({
  authedClient: () => authedClientMock(),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { cancelRun } from "./runs";

/** Fake user-scoped `supabase` client for the search_profiles ownership check. */
function fakeSupabaseProfileLookup(ownedProfileId: string | null) {
  return {
    from(table: string) {
      if (table !== "search_profiles") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    async single() {
                      return ownedProfileId
                        ? { data: { id: ownedProfileId }, error: null }
                        : { data: null, error: { message: "no rows" } };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

/** Fake service-role `admin` client that records every .eq() filter applied to the update. */
function fakeAdminRecordingUpdate() {
  const eqCalls: Array<[string, unknown]> = [];
  let updatePayload: unknown = null;
  const chain = {
    eq(column: string, value: unknown) {
      eqCalls.push([column, value]);
      return chain;
    },
  };
  const admin = {
    from(table: string) {
      if (table !== "run_logs") throw new Error(`unexpected table: ${table}`);
      return {
        update(payload: unknown) {
          updatePayload = payload;
          return chain;
        },
      };
    },
  };
  return { admin, eqCalls, getUpdatePayload: () => updatePayload };
}

describe("cancelRun", () => {
  beforeEach(() => {
    authedClientMock.mockReset();
    createAdminClientMock.mockReset();
  });

  it("REGRESSION (#46): scopes the run_logs UPDATE to the caller's own profile_id, not just runId+status", async () => {
    const ownProfileId = "profile_attacker_owns";
    authedClientMock.mockResolvedValue({
      supabase: fakeSupabaseProfileLookup(ownProfileId),
      user: { id: "attacker" },
    });
    const { admin, eqCalls } = fakeAdminRecordingUpdate();
    createAdminClientMock.mockReturnValue(admin);

    // Attacker passes a profileId they legitimately own, together with
    // ANOTHER tenant's run_logs.id — the exact failure scenario from #46.
    await cancelRun("victims_run_id", ownProfileId);

    expect(eqCalls).toContainEqual(["id", "victims_run_id"]);
    expect(eqCalls).toContainEqual(["profile_id", ownProfileId]);
    expect(eqCalls).toContainEqual(["status", "running"]);
  });

  it("does not touch run_logs at all when the caller does not own profileId", async () => {
    authedClientMock.mockResolvedValue({
      supabase: fakeSupabaseProfileLookup(null), // ownership check finds no row
      user: { id: "attacker" },
    });
    const { admin, eqCalls } = fakeAdminRecordingUpdate();
    createAdminClientMock.mockReturnValue(admin);

    await cancelRun("some_run_id", "profile_not_owned");

    expect(eqCalls).toHaveLength(0);
  });

  it("the legitimate path still works: a user cancelling their own run under their own profile", async () => {
    const profileId = "profile_1";
    authedClientMock.mockResolvedValue({
      supabase: fakeSupabaseProfileLookup(profileId),
      user: { id: "owner" },
    });
    const { admin, eqCalls, getUpdatePayload } = fakeAdminRecordingUpdate();
    createAdminClientMock.mockReturnValue(admin);

    await cancelRun("own_run_id", profileId);

    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ["id", "own_run_id"],
        ["profile_id", profileId],
        ["status", "running"],
      ]),
    );
    expect(getUpdatePayload()).toMatchObject({ status: "failed", error_message: "Cancelled by user" });
  });
});
