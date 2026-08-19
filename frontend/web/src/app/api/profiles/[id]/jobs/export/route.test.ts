import { beforeEach, describe, expect, it, vi } from "vitest";

// C67: this route used a flat .limit(1000) — a profile with more than 1000
// matching jobs silently exported only the first page, with nothing in the
// CSV indicating the export was incomplete. Pins that a second page of
// results is fetched and included when the first page is exactly full.

function job(n: number) {
  return {
    title: `Job ${n}`, company: "Acme", location: "Sydney", source: "seek",
    source_tier: 1, posted_at: null, visa_likelihood: null,
    keywords_matched: [], url: `https://example.com/${n}`,
    applied_at: null, dismissed_at: null, created_at: "2026-01-01",
  };
}

const mocks = vi.hoisted(() => {
  const profileQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  profileQuery.select = vi.fn(() => profileQuery);
  profileQuery.eq     = vi.fn(() => profileQuery);
  profileQuery.single = vi.fn();

  const pages: Array<{ data: unknown[]; error: null }> = [];
  const rangeCalls: Array<[number, number]> = [];

  const jobsQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  jobsQuery.select = vi.fn(() => jobsQuery);
  jobsQuery.eq     = vi.fn(() => jobsQuery);
  jobsQuery.gte    = vi.fn(() => jobsQuery);
  jobsQuery.is     = vi.fn(() => jobsQuery);
  jobsQuery.order  = vi.fn(() => jobsQuery);
  jobsQuery.range  = vi.fn((from: number, to: number) => {
    rangeCalls.push([from, to]);
    const page = pages[rangeCalls.length - 1] ?? { data: [], error: null };
    return Promise.resolve(page);
  });

  return { profileQuery, jobsQuery, pages, rangeCalls };
});

vi.mock("@/lib/api-utils", () => ({
  jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
  withUser: (handler: (
    request: unknown,
    context: unknown,
    auth: { user: { id: string; email: string }; supabase: unknown },
  ) => Promise<Response>) =>
    (request: unknown, context: unknown) => handler(request, context, {
      user: { id: "user-1", email: "user@example.com" },
      supabase: {
        from: (table: string) => (table === "search_profiles" ? mocks.profileQuery : mocks.jobsQuery),
      },
    }),
}));

describe("GET /api/profiles/[id]/jobs/export", () => {
  beforeEach(() => {
    mocks.profileQuery.single.mockReset().mockResolvedValue({ data: { id: "p1", name: "AIN Sydney" } });
    mocks.jobsQuery.range.mockClear();
    mocks.rangeCalls.length = 0;
    mocks.pages.length = 0;
  });

  it("fetches a second page when the first page is exactly full, and includes both in the CSV", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => job(i));
    const page2 = [job(1000), job(1001)];
    mocks.pages.push({ data: page1, error: null }, { data: page2, error: null });

    const { GET } = await import("./route");
    const req = { nextUrl: new URL("https://jobtrackr.com.au/api/profiles/p1/jobs/export") };
    const res = await GET(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: "p1" }) });

    expect(mocks.rangeCalls).toEqual([[0, 999], [1000, 1999]]);
    const csv = await res.text();
    const dataLines = csv.trim().split("\r\n").slice(1); // drop header
    expect(dataLines).toHaveLength(1002);
    expect(csv).toContain("Job 1001");
  });

  it("stops after one page when it comes back short", async () => {
    mocks.pages.push({ data: [job(0), job(1)], error: null });

    const { GET } = await import("./route");
    const req = { nextUrl: new URL("https://jobtrackr.com.au/api/profiles/p1/jobs/export") };
    await GET(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: "p1" }) });

    expect(mocks.rangeCalls).toEqual([[0, 999]]);
  });
});
