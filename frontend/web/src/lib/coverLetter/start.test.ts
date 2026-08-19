/**
 * Regression test for #47 (audit): `startCoverLetter` marked the previous
 * (completed, is_stale=false) letter `is_stale: true` right after the
 * billing gate — BEFORE four early-return failure paths (no AI provider
 * configured, no company research, variants-generation failure, insert
 * failure). Every read path (board-detail panel, email-draft route) filters
 * `is_stale = false`, so a regenerate that fails on any of those four paths
 * left the user with neither a new letter nor their old, completed,
 * hand-edited one — data-loss-shaped from the user's point of view.
 *
 * Fix: the mark-stale mutation only runs once the new `cover_letters` row
 * has actually been inserted, so a failure anywhere before that point
 * leaves the previous letter reachable.
 *
 * This test builds a minimal recording fake for the service-role client
 * (this repo's established pattern — see lib/actions/runs.test.ts) rather
 * than mocking the real Supabase client, and forces each of the four
 * failure paths in turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const rateLimitMock = vi.fn();
vi.mock("@/lib/rateLimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  RATE_LIMIT_MESSAGE: "rate limited",
}));

const getActiveAiCredentialsMock = vi.fn();
vi.mock("@/lib/ai/activeProvider", () => ({
  getActiveAiCredentials: () => getActiveAiCredentialsMock(),
}));

const generateOpeningVariantsMock = vi.fn();
const matchStoriesMock = vi.fn();
class FakeCvBackendError extends Error {
  status = 502;
  detail = {};
}
vi.mock("@/lib/cv/backend", () => ({
  generateOpeningVariants: (...args: unknown[]) => generateOpeningVariantsMock(...args),
  matchStories: (...args: unknown[]) => matchStoriesMock(...args),
  CvBackendError: FakeCvBackendError,
}));

const consumeCoverLetterMock = vi.fn();
const linkUsageEventMock = vi.fn();
const releaseUsageEventMock = vi.fn();
vi.mock("@/lib/billing/entitlements", () => ({
  consumeCoverLetter: (...args: unknown[]) => consumeCoverLetterMock(...args),
  linkUsageEvent: (...args: unknown[]) => linkUsageEventMock(...args),
  releaseUsageEvent: (...args: unknown[]) => releaseUsageEventMock(...args),
}));

const { startCoverLetter } = await import("./start");

type Resp = { data: unknown; error: unknown };
type Call = { type: "insert" | "update"; table: string; payload: unknown };

/** Recording fake for the service-role client — records every insert/update
 * call (in invocation order) and answers select/insert/update terminal
 * calls from per-table, per-op FIFO queues. */
function makeFakeAdmin(config: {
  select?: Record<string, Resp[]>;
  insert?: Record<string, Resp[]>;
  update?: Record<string, Resp>;
}) {
  const calls: Call[] = [];

  function makeChain(resolve: () => Resp) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (onFulfilled: (r: Resp) => unknown, onRejected: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return chain;
  }

  return {
    admin: {
      from(table: string) {
        return {
          select: () =>
            makeChain(() => {
              const queue = config.select?.[table];
              if (!queue || queue.length === 0) {
                throw new Error(`no select response queued for "${table}"`);
              }
              return queue.shift()!;
            }),
          insert: (payload: unknown) => {
            calls.push({ type: "insert", table, payload });
            return makeChain(() => {
              const queue = config.insert?.[table];
              if (!queue || queue.length === 0) {
                throw new Error(`no insert response queued for "${table}"`);
              }
              return queue.shift()!;
            });
          },
          update: (payload: unknown) => {
            calls.push({ type: "update", table, payload });
            return makeChain(() => config.update?.[table] ?? { data: null, error: null });
          },
        };
      },
    },
    calls,
  };
}

function baseSelects(overrides: Partial<Record<string, Resp[]>> = {}) {
  return {
    jobs: [
      {
        data: {
          id: "job1",
          profile_id: "profile1",
          title: "Registered Nurse",
          company: "Acme Health",
          // Long enough manual JD so step 4 never issues a second
          // analysis_runs query for jd_text.
          manual_jd_text: "x".repeat(60),
          description: null,
        },
        error: null,
      },
    ],
    search_profiles: [{ data: { user_id: "user1", target_verticals: [] }, error: null }],
    // passed_final_gate: true skips the nested user_preferences lookup.
    analysis_runs: [{ data: { tailored_match_score: 90, passed_final_gate: true }, error: null }],
    cv_versions: [{ data: { id: "cv1", cv_text: "some cv text" }, error: null }],
    voice_profiles: [{ data: { fingerprint: {}, voice_sample_raw: "sample" }, error: null }],
    cover_letters: [{ data: { id: "old_letter_id", status: "completed" }, error: null }],
    // tsRow = null skips the whole stories block (no stories is not a blocker).
    stories: [{ data: null, error: null }],
    company_research: [
      { data: { facts: { distinguishing_facts: ["Acme Health cares deeply about staff"] } }, error: null },
    ],
    ...overrides,
  };
}

function makeRequest() {
  return new NextRequest("http://localhost/api/jobs/job1/cover-letter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ regenerate: true }),
  });
}

function staleUpdateIndex(calls: Call[]) {
  return calls.findIndex(
    (c) =>
      c.type === "update" &&
      c.table === "cover_letters" &&
      (c.payload as { is_stale?: boolean }).is_stale === true,
  );
}

function insertIndex(calls: Call[]) {
  return calls.findIndex((c) => c.type === "insert" && c.table === "cover_letters");
}

describe("startCoverLetter — previous letter must stay reachable if regenerate fails", () => {
  beforeEach(() => {
    createAdminClientMock.mockReset();
    rateLimitMock.mockReset().mockResolvedValue({ allowed: true });
    getActiveAiCredentialsMock.mockReset();
    generateOpeningVariantsMock.mockReset();
    matchStoriesMock.mockReset();
    consumeCoverLetterMock.mockReset().mockResolvedValue({ allowed: true, eventId: "evt1" });
    linkUsageEventMock.mockReset().mockResolvedValue(undefined);
    releaseUsageEventMock.mockReset().mockResolvedValue(undefined);
  });

  it("REGRESSION (#47): does not mark the previous letter stale when no AI provider is configured", async () => {
    const { admin, calls } = makeFakeAdmin({ select: baseSelects() });
    createAdminClientMock.mockReturnValue(admin);
    getActiveAiCredentialsMock.mockResolvedValue(null); // forces the 422 early-return

    const res = await startCoverLetter(makeRequest(), "job1", { id: "user1" });

    expect(res.status).toBe(422);
    expect(staleUpdateIndex(calls)).toBe(-1);
  });

  it("REGRESSION (#47): does not mark the previous letter stale when company research is missing", async () => {
    const { admin, calls } = makeFakeAdmin({
      select: baseSelects({ company_research: [{ data: null, error: null }] }),
    });
    createAdminClientMock.mockReturnValue(admin);
    getActiveAiCredentialsMock.mockResolvedValue({ provider: "anthropic", apiKey: "k", model: null });

    const res = await startCoverLetter(makeRequest(), "job1", { id: "user1" });

    expect(res.status).toBe(422);
    expect(staleUpdateIndex(calls)).toBe(-1);
  });

  it("REGRESSION (#47): does not mark the previous letter stale when variants generation fails", async () => {
    const { admin, calls } = makeFakeAdmin({ select: baseSelects() });
    createAdminClientMock.mockReturnValue(admin);
    getActiveAiCredentialsMock.mockResolvedValue({ provider: "anthropic", apiKey: "k", model: null });
    generateOpeningVariantsMock.mockRejectedValue(new Error("cv-backend down"));

    const res = await startCoverLetter(makeRequest(), "job1", { id: "user1" });

    expect(res.status).toBe(502);
    expect(staleUpdateIndex(calls)).toBe(-1);
  });

  it("REGRESSION (#47): does not mark the previous letter stale when the new-letter insert fails", async () => {
    const { admin, calls } = makeFakeAdmin({
      select: baseSelects(),
      insert: { cover_letters: [{ data: null, error: { message: "insert boom" } }] },
    });
    createAdminClientMock.mockReturnValue(admin);
    getActiveAiCredentialsMock.mockResolvedValue({ provider: "anthropic", apiKey: "k", model: null });
    generateOpeningVariantsMock.mockResolvedValue({ variants: [{ id: "v1", text: "Dear hiring manager" }] });

    const res = await startCoverLetter(makeRequest(), "job1", { id: "user1" });

    expect(res.status).toBe(500);
    expect(staleUpdateIndex(calls)).toBe(-1);
  });

  it("the legitimate path still works: marks the previous letter stale AFTER the new one is created", async () => {
    const { admin, calls } = makeFakeAdmin({
      select: baseSelects(),
      insert: { cover_letters: [{ data: { id: "new_letter_id" }, error: null }] },
    });
    createAdminClientMock.mockReturnValue(admin);
    getActiveAiCredentialsMock.mockResolvedValue({ provider: "anthropic", apiKey: "k", model: null });
    generateOpeningVariantsMock.mockResolvedValue({ variants: [{ id: "v1", text: "Dear hiring manager" }] });

    const res = await startCoverLetter(makeRequest(), "job1", { id: "user1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.letter_id).toBe("new_letter_id");
    const staleIdx = staleUpdateIndex(calls);
    const insIdx = insertIndex(calls);
    expect(staleIdx).toBeGreaterThan(-1);
    expect(insIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeGreaterThan(insIdx);
  });
});
