/**
 * C67: deleteProfile's DELETE query matching zero rows (wrong owner, a
 * stale/tampered id, or a profile already deleted by a concurrent request)
 * is not an error to Supabase/PostgREST — it returns {error: null} exactly
 * like a genuine delete. Without inspecting the returned rows, this silently
 * "succeeded" and redirected to /profiles having deleted nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authedClientMock = vi.fn();
vi.mock("./_helpers", () => ({
  authedClient: () => authedClientMock(),
  triggerScheduleSync: vi.fn(),
  extractAdzunaFields: vi.fn(),
  extractAutomationFields: vi.fn(),
  extractSourceFields: vi.fn(),
  extractSettingFilter: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
}));

vi.mock("@/lib/billing/entitlements", () => ({
  assertCanCreateProfile: vi.fn(),
  getEntitlement: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/setupStatus", () => ({ getSetupStatus: vi.fn() }));
vi.mock("@/lib/setupSteps", () => ({ isSetupComplete: vi.fn() }));

import { deleteProfile } from "./profiles";
import { triggerScheduleSync } from "./_helpers";
import { redirect } from "next/navigation";

/** Fake user-scoped supabase client where .delete().eq().eq().select() resolves to `rows`. */
function fakeSupabaseDelete(rows: Array<{ id: string }> | null, error: { message: string } | null = null) {
  return {
    from(table: string) {
      if (table !== "search_profiles") throw new Error(`unexpected table: ${table}`);
      return {
        delete() {
          return {
            eq() {
              return {
                eq() {
                  return { select: () => Promise.resolve({ data: rows, error }) };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("deleteProfile", () => {
  beforeEach(() => {
    authedClientMock.mockReset();
    vi.mocked(triggerScheduleSync).mockReset();
    vi.mocked(redirect).mockClear();
  });

  it("throws instead of reporting success when the delete matches zero rows", async () => {
    authedClientMock.mockResolvedValue({
      supabase: fakeSupabaseDelete([]),
      user: { id: "user-1" },
    });

    await expect(deleteProfile("someone-elses-profile")).rejects.toThrow(/not found|already deleted/i);
    expect(triggerScheduleSync).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("proceeds (triggers sync + redirects) when a row is actually deleted", async () => {
    authedClientMock.mockResolvedValue({
      supabase: fakeSupabaseDelete([{ id: "profile-1" }]),
      user: { id: "user-1" },
    });

    await expect(deleteProfile("profile-1")).rejects.toThrow("NEXT_REDIRECT");
    expect(triggerScheduleSync).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/profiles");
  });

  it("still surfaces a genuine Supabase error", async () => {
    authedClientMock.mockResolvedValue({
      supabase: fakeSupabaseDelete(null, { message: "connection reset" }),
      user: { id: "user-1" },
    });

    await expect(deleteProfile("profile-1")).rejects.toThrow("connection reset");
    expect(triggerScheduleSync).not.toHaveBeenCalled();
  });
});
