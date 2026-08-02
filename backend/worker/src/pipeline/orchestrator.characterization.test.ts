/**
 * Characterization ("golden master") tests for runPipeline.
 *
 * PURPOSE: this file exists to make a behaviour-preserving refactor of
 * orchestrator.ts verifiable. It does NOT assert that the current behaviour is
 * CORRECT — it asserts that it is UNCHANGED. Several expectations below pin
 * known-quirky behaviour on purpose (see PINNED BUG markers). If you are
 * deliberately changing behaviour, you must update these expectations as a
 * conscious act, not "fix the failing test".
 *
 * What it observes (the four windows onto the pipeline):
 *   1. the ordered setStage() strings      → stage sequence + which stages fired
 *   2. the exact array handed to saveJobs() → the whole filter/enrich/dedup chain
 *   3. the finishRunLog() payload           → every run metric
 *   4. the ordered table writes             → side effects and their order
 *
 * Everything at an I/O boundary is mocked. Deliberately left REAL, because they
 * are pure and are part of what we want pinned: normalise, keywordFilter,
 * postFetchFilter, dedup, jdFacts extractors, eligibility, settingFilter.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RawJob } from "../sources/types.js";

// ── Shared, hoisted test state ────────────────────────────────────────────────
// vi.mock factories are hoisted above imports, so anything they close over must
// come from vi.hoisted().
const H = vi.hoisted(() => {
  interface DbCall {
    table: string;
    op: "select" | "insert" | "update" | "upsert" | "delete";
    columns?: string;
    payload?: unknown;
    filters: Array<{ fn: string; args: unknown[] }>;
    terminal: "single" | "maybeSingle" | null;
  }

  const state = {
    /** Ordered setStage() strings. */
    stages: [] as string[],
    /** Ordered "table.op" for every write. */
    writes: [] as string[],
    /**
     * Ordered trace of every collaborator call, with its input size. This is
     * the window that catches REORDERING — the other four all compare end
     * state, which a moved operation can leave untouched.
     */
    trace: [] as string[],
    /** Every db call, for debugging a failing expectation. */
    calls: [] as DbCall[],
    /** Captured saveJobs() input. */
    savedJobs: null as unknown[] | null,
    /** Captured finishRunLog() payload. */
    finished: null as Record<string, unknown> | null,
    /** Captured pending_job_notifications insert payload. */
    notified: null as unknown,
    /** Captured autoAnalyzeBatch ids. */
    autoAnalyzed: null as string[] | null,

    // ── Per-test knobs ────────────────────────────────────────────────────
    bucketOn: false,
    /** Rows each mocked adapter returns, keyed by adapter name. */
    adapterJobs: {} as Record<string, RawJob[]>,
    /** Adapter names that should throw instead of returning. */
    adapterThrows: new Set<string>(),
    /** Rows seekDirectAdapter returns (null ⇒ throw). */
    seekDirectJobs: [] as RawJob[] | null,
    /** run_logs rows returned by the "already running?" probe. */
    activeRuns: [] as Array<{ id: string; started_at: string }>,
    /** What serveProfileFromBucket returns (null ⇒ serve unavailable). */
    serveResult: null as unknown[] | null,
    /** What upsertGlobalJobs returns. */
    upsertOk: true,
    /** Force a throw from setStage once its arg contains this substring. */
    throwOnStage: null as string | null,
    /** Make the cancellation probe report the run as cancelled. */
    cancelled: false,
    /** Treat the profile as an is_manual "Saved Jobs" container. */
    isManual: false,
    /** User-level visa status served from user_preferences. */
    userVisaStatus: "citizen" as string,
    /** title -> work_rights_requirement, injected by the visaExtractor mock. */
    visaByTitle: {} as Record<string, string>,
    /** saveJobs' newSaved return (null ⇒ "every row was new"). */
    newSaved: null as number | null,
  };

  // ── Chainable Supabase query-builder mock ───────────────────────────────
  const FILTERS = [
    "eq", "neq", "in", "gte", "lte", "lt", "gt", "is", "or",
    "order", "limit", "filter", "not", "contains",
  ];

  class QB implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
    call: DbCall;
    constructor(table: string) {
      this.call = { table, op: "select", filters: [], terminal: null };
      for (const fn of FILTERS) {
        (this as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
          this.call.filters.push({ fn, args });
          return this;
        };
      }
    }
    select(columns?: string) { this.call.columns = columns; return this; }
    insert(payload: unknown) { this.call.op = "insert"; this.call.payload = payload; return this; }
    update(payload: unknown) { this.call.op = "update"; this.call.payload = payload; return this; }
    upsert(payload: unknown) { this.call.op = "upsert"; this.call.payload = payload; return this; }
    delete() { this.call.op = "delete"; return this; }
    single() { this.call.terminal = "single"; return this; }
    maybeSingle() { this.call.terminal = "maybeSingle"; return this; }

    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown; count?: number }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      state.calls.push(this.call);
      if (this.call.op !== "select") state.writes.push(`${this.call.table}.${this.call.op}`);
      return Promise.resolve(resolve(this.call)).then(onOk, onErr);
    }
  }

  const PROFILE = {
    id: "profile-1",
    name: "Nursing — Sydney",
    user_id: "user-1",
    is_manual: false,
    // Broad enough that all three distinct fixture titles survive the
    // title-only keyword filter.
    keywords: ["nurse"],
    location: "Sydney NSW",
    visa_filter_mode: "all",
    target_verticals: null,
    setting_filter: null,
    must_include_phrases: null,
    exclude_title_keywords: null,
    automation_enabled: true,
    enabled_sources: null,
    seek_method: "direct",
    adzuna_method: "api",
    home_address: null,
    home_lat: null,
    home_lng: null,
  };

  function resolve(c: DbCall): { data: unknown; error: unknown; count?: number } {
    const ok = (data: unknown, count?: number) => ({ data, error: null, count });
    switch (c.table) {
      case "search_profiles":
        // loadProfile uses .single(); the sibling-profile probe uses .neq().
        if (c.terminal === "single") return ok({ ...PROFILE, is_manual: state.isManual });
        if (c.op === "update") return ok(null);
        return ok([]);                        // no sibling profiles
      case "user_preferences":
        return ok({ contact_details: { visa_status: state.userVisaStatus, credentials: {} } });
      case "users":
        // Two shapes: loadPlatformSources does .eq("id").maybeSingle() → row;
        // loadApifyIntegration does .in("role", [...]) → array.
        return c.terminal === "maybeSingle" ? ok({ role: "user" }) : ok([]);
      case "subscriptions":
        return ok({ plan_id: "monthly", status: "active" });
      case "platform_source_tiers":
        return ok({
          enabled_sources: ["adzuna", "careerjet", "seek"],
          adzuna_method: "api",
          seek_method: "direct",
        });
      case "run_logs": {
        if (c.op === "update") return ok([]);            // stale-lock expiry: none
        // checkCancellation probes status via maybeSingle with a single eq(id).
        const onlyIdFilter =
          c.terminal === "maybeSingle" && c.columns === "status";
        if (onlyIdFilter) return ok({ status: state.cancelled ? "failed" : "running" });
        if (c.columns === "started_at") return ok(null);  // no previous completed run
        return ok(state.activeRuns);
      }
      case "user_integrations":
        return ok(null);                                  // no Apify integration
      case "jobs":
        if (c.op === "update") return ok(null, 0);
        return ok([]);                                    // no pre-existing jobs
      case "pending_job_notifications":
        state.notified = c.payload;
        return ok(null);
      default:
        return ok(null);
    }
  }

  const db = {
    from: (table: string) => new QB(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };

  return { state, db, PROFILE };
});

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("../db/client.js", () => ({ db: H.db }));

vi.mock("./runLog.js", () => ({
  startRunLog: vi.fn(async () => { H.state.trace.push("startRunLog"); return "run-1"; }),
  setStage: vi.fn(async (_id: string, stage: string) => {
    H.state.stages.push(stage);
    if (H.state.throwOnStage && stage.includes(H.state.throwOnStage)) {
      throw new Error("setStage exploded");
    }
  }),
  finishRunLog: vi.fn(async (_id: string, outcome: Record<string, unknown>) => {
    H.state.trace.push(`finishRunLog:${outcome.status}`);
    H.state.finished = outcome;
  }),
}));

vi.mock("./save.js", () => ({
  saveJobs: vi.fn(async (jobs: unknown[]) => {
    H.state.trace.push(`save:${jobs.length}`);
    H.state.savedJobs = jobs;
    const bySource: Record<string, number> = {};
    for (const j of jobs as Array<{ source: string }>) {
      bySource[j.source] = (bySource[j.source] ?? 0) + 1;
    }
    return {
      saved: jobs.length,
      newSaved: H.state.newSaved ?? jobs.length,
      errors: 0,
      bySource,
      savedIds: jobs.map((_, i) => `job-${i}`),
    };
  }),
}));

vi.mock("./bucket.js", () => ({
  bucketEnabled: () => H.state.bucketOn,
  BUCKET_RETENTION_DAYS: 30,
  evictStaleBucket: vi.fn(async () => { H.state.trace.push("bucketEvict"); }),
  upsertGlobalJobs: vi.fn(async (jobs: unknown[]) => {
    H.state.trace.push(`bucketUpsert:${jobs.length}`);
    return H.state.upsertOk;
  }),
  serveProfileFromBucket: vi.fn(async () => {
    H.state.trace.push("bucketServe");
    return H.state.serveResult;
  }),
}));

vi.mock("./coverage.js", () => ({
  resolveSlices: () => [{ keyword_norm: "registered nurse", location_cell: "sydney", source: "adzuna" }],
  readCoverage: async () => new Map(),
  computeProfileLookback: () => ({ lookbackDays: 7, allFresh: false }),
  sliceDeltaDays: () => 7,
  acquireSliceLocks: async () => 1,
  releaseSliceLocks: async () => {},
  recordCoverage: vi.fn(async () => { H.state.trace.push("recordCoverage"); }),
}));

vi.mock("./healthTracker.js", () => ({
  isBlocked: async () => false,
  recordSuccess: async () => {},
  recordFailure: async () => 1,
}));

vi.mock("../sources/index.js", () => ({
  adapters: ["adzuna", "careerjet"].map((name) => ({
    name,
    tier: 1 as const,
    vertical: "general" as const,
    rateLimitDelay: 0,
    fetchJobs: async () => {
      H.state.trace.push(`fetch:${name}`);
      if (H.state.adapterThrows.has(name)) throw new Error(`${name} is down`);
      return H.state.adapterJobs[name] ?? [];
    },
    isHealthy: async () => true,
  })),
}));

vi.mock("../sources/seekDirect.js", () => ({
  seekDirectAdapter: {
    name: "seek",
    fetchJobs: async () => {
      H.state.trace.push("fetch:seek-direct");
      if (H.state.seekDirectJobs === null) throw new Error("seek-direct down");
      return H.state.seekDirectJobs;
    },
  },
  enrichWithDirectJDs: vi.fn(async (jobs: unknown[]) => {
    H.state.trace.push(`seekJd:${jobs.length}`);
    return { jobs, merged: 0, fetched: 0 };
  }),
}));

vi.mock("../sources/seek.js", () => ({ createSeekAdapter: () => null }));
vi.mock("../sources/careerjetActor.js", () => ({ enrichCareerjetJDsViaActor: vi.fn() }));
vi.mock("../sources/adzunaActor.js", () => ({ enrichAdzunaJDsViaActor: vi.fn() }));
vi.mock("../sources/adzuna.js", () => ({
  enrichWithAdzunaJDs: vi.fn(),
  ADZUNA_DIRECT_JD_FETCH_CAP: 40,
}));
vi.mock("../lib/crypto.js", () => ({ decryptApiKey: () => "token" }));

vi.mock("../ai/visaExtractor.js", () => ({
  extractVisaInfo: async (jobs: Array<{ url_hash: string; title: string }>) => {
    H.state.trace.push(`visa:${jobs.length}`);
    const m = new Map<string, unknown>();
    for (const j of jobs) {
      const req = H.state.visaByTitle[j.title];
      if (!req) continue;
      m.set(j.url_hash, {
        sponsorship_status: "not_mentioned",
        citizen_pr_only: null,
        visa_extracted_text: null,
        work_rights_requirement: req,
      });
    }
    return m;
  },
}));
vi.mock("../ai/settingClassifier.js", () => ({
  classifySettings: async (jobs: unknown[]) => { H.state.trace.push(`settings:${jobs.length}`); return new Map(); },
}));

vi.mock("../lib/distance.js", () => ({
  geocode: async () => null,
  geocodeLocation: async () => null,     // no distance origin ⇒ stage 11b skipped
  distanceFor: async () => null,
}));

vi.mock("../notifications/gate.js", () => ({
  applyGate: async () => { H.state.trace.push("gate"); return { proceed: true }; },
}));
vi.mock("../notifications/errorAlert.js", () => ({ sendPipelineFailureAlert: vi.fn(async () => {}) }));
vi.mock("../automation/triggerAutoAnalyze.js", () => ({
  autoAnalyzeBatch: vi.fn(async (ids: string[]) => {
    H.state.trace.push(`autoAnalyze:${ids.length}`);
    H.state.autoAnalyzed = ids;
    return { triggered: ids.length, skipped: 0 };
  }),
}));

const { runPipeline } = await import("./orchestrator/index.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Descriptions deliberately contain NO closing-date language: extractClosingDate
// runs for real against `new Date()`, and date language would make the golden
// master depend on the wall clock.
function raw(over: Partial<RawJob> & { url: string }): RawJob {
  return {
    title: "Registered Nurse",
    company: "Acme Health",
    location: "Sydney NSW",
    description: "We are seeking a registered nurse for our Sydney team.",
    source: "adzuna",
    source_tier: 1,
    posted_at: "2026-07-01T00:00:00Z",
    expires_at: null,
    ...over,
  };
}

beforeEach(() => {
  const s = H.state;
  s.stages = [];
  s.writes = [];
  s.trace = [];
  s.calls = [];
  s.savedJobs = null;
  s.finished = null;
  s.notified = null;
  s.autoAnalyzed = null;
  s.bucketOn = false;
  // Deliberately DISTINCT title+company per job. Identical ones collapse under
  // L2-strong dedup (see the pinned test below) — which is correct behaviour,
  // but it would hide the rest of the pipeline from the golden master.
  s.adapterJobs = {
    adzuna: [raw({
      url: "https://www.adzuna.com.au/details/111",
      title: "Registered Nurse", company: "Acme Health",
    })],
    careerjet: [raw({
      url: "https://www.careerjet.com/jobad/222", source: "careerjet",
      title: "Enrolled Nurse", company: "Bright Care",
    })],
  };
  s.adapterThrows = new Set();
  s.seekDirectJobs = [raw({
    url: "https://www.seek.com.au/job/333", source: "seek",
    title: "Clinical Nurse Specialist", company: "Metro Hospital",
  })];
  s.activeRuns = [];
  s.serveResult = null;
  s.upsertOk = true;
  s.throwOnStage = null;
  s.cancelled = false;
  s.isManual = false;
  s.userVisaStatus = "citizen";
  s.visaByTitle = {};
  s.newSaved = null;
});

const savedUrls = () =>
  (H.state.savedJobs as Array<{ url: string }> | null)?.map((j) => j.url).sort() ?? null;

// ── A. Golden master ──────────────────────────────────────────────────────────
describe("A. golden master — legacy mode (USE_GLOBAL_BUCKET off)", () => {
  it("runs every stage in a fixed order", async () => {
    await runPipeline("profile-1", "auto");
    expect(H.state.stages).toEqual([
      "Fetching from 2 sources (up to 6 at a time)",
      "Fetching from SEEK",
      "Filtering & deduplicating",
      "Fetching full SEEK descriptions",
      "Extracting visa info (3 jobs)",
      "Classifying work setting (3 jobs)",
      "Saving 3 jobs",
      "Auto-analyzing 3 jobs",
    ]);
  });

  it("hands saveJobs the full survivor set", async () => {
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual([
      "https://www.adzuna.com.au/details/111",
      "https://www.careerjet.com/jobad/222",
      "https://www.seek.com.au/job/333",
    ]);
  });

  it("reports a stable metric payload to finishRunLog", async () => {
    await runPipeline("profile-1", "auto");
    expect(H.state.finished).toEqual({
      status: "completed",
      jobs_fetched: 3,
      jobs_after_dedup: 3,
      jobs_saved: 3,
      jobs_deduped: 0,
      sources_run: ["adzuna", "careerjet", "seek"],
      sources_saved: { adzuna: 1, careerjet: 1, seek: 1 },
      source_methods: {
        tier: "monthly",
        seek: { enabled: true, listings: "direct", count: 1, jd: "teaser", merged: 0, fetched: 0 },
        careerjet: { enabled: true, method: "api" },
        adzuna: { enabled: true, method: "api", enrichment: "none" },
      },
    });
  });

  it("performs its side effects in a fixed order", async () => {
    await runPipeline("profile-1", "auto");
    expect(H.state.writes).toEqual([
      "run_logs.update",                  // stale-lock expiry sweep
      "pending_job_notifications.insert", // new-jobs queue (auto trigger only)
      "jobs.update",                      // visa_likelihood backfill ×3
      "jobs.update",
      "jobs.update",
    ]);
    expect(H.state.autoAnalyzed).toEqual(["job-0", "job-1", "job-2"]);
  });

  it("collapses the same role found by three sources down to one", async () => {
    // PINNED BEHAVIOUR: identical title+company+city across sources is an
    // L2-strong match, so only the highest-scoring source survives (seek 2000 >
    // careerjet 1800 > adzuna 400). Discovered by this harness, not assumed.
    const same = { title: "Registered Nurse", company: "Acme Health" };
    H.state.adapterJobs = {
      adzuna:    [raw({ url: "https://www.adzuna.com.au/details/111", ...same })],
      careerjet: [raw({ url: "https://www.careerjet.com/jobad/222", source: "careerjet", ...same })],
    };
    H.state.seekDirectJobs = [raw({ url: "https://www.seek.com.au/job/333", source: "seek", ...same })];
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual(["https://www.seek.com.au/job/333"]);
    expect(H.state.finished).toMatchObject({ jobs_deduped: 2, jobs_saved: 1 });
  });

  it("does not queue a notification for a manual run", async () => {
    await runPipeline("profile-1", "manual");
    expect(H.state.notified).toBeNull();
    expect(H.state.writes).not.toContain("pending_job_notifications.insert");
  });
});

describe("A. golden master — bucket mode (USE_GLOBAL_BUCKET on)", () => {
  beforeEach(() => { H.state.bucketOn = true; });

  it("replaces the scraped set with what the bucket serves", async () => {
    H.state.serveResult = [
      { ...raw({ url: "https://www.seek.com.au/job/999" }), url_hash: "h9", source: "seek" },
    ];
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual(["https://www.seek.com.au/job/999"]);
    expect(H.state.finished).toMatchObject({ status: "completed", jobs_saved: 1 });
  });

  it("trusts a legitimately EMPTY serve result", async () => {
    // Regression guard for c01ed6da: an empty serve is a real answer, not a
    // failure to fall back from.
    H.state.serveResult = [];
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual([]);
  });

  it("keeps the scraped set when the bucket upsert failed", async () => {
    // Regression guard for ef987615: an empty serve after a FAILED upsert is a
    // masked failure, so the scraped set must survive.
    H.state.upsertOk = false;
    H.state.serveResult = [];
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toHaveLength(3);
  });

  it("keeps the scraped set when serve is unavailable", async () => {
    H.state.serveResult = null;
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toHaveLength(3);
  });
});

// ── B. Failure paths ──────────────────────────────────────────────────────────
describe("B. failure paths", () => {
  it("isolates a failing adapter — the run completes without it", async () => {
    H.state.adapterThrows = new Set(["careerjet"]);
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual([
      "https://www.adzuna.com.au/details/111",
      "https://www.seek.com.au/job/333",
    ]);
    expect(H.state.finished).toMatchObject({
      status: "completed",
      sources_run: ["adzuna", "seek"],   // careerjet absent — it failed
    });
  });

  it("falls back gracefully when seek-direct throws and no Apify exists", async () => {
    H.state.seekDirectJobs = null;
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual([
      "https://www.adzuna.com.au/details/111",
      "https://www.careerjet.com/jobad/222",
    ]);
    expect(H.state.finished).toMatchObject({
      source_methods: expect.objectContaining({
        seek: expect.objectContaining({ listings: "skipped" }),
      }),
    });
  });

  /**
   * CONSTRAINT C3 — this is the test that fails if run metrics are ever turned
   * into pure stage return values instead of a mutated accumulator. A throw
   * after stage 2 must still report the sources that already succeeded.
   */
  it("preserves partial metrics when a stage throws mid-run", async () => {
    H.state.throwOnStage = "Saving";
    await runPipeline("profile-1", "auto");
    expect(H.state.finished).toMatchObject({
      status: "failed",
      error_message: "setStage exploded",
      jobs_fetched: 3,                              // survived the throw
      sources_run: ["adzuna", "careerjet", "seek"], // survived the throw
    });
  });

  it("does not write a failed run log when the user cancelled", async () => {
    H.state.cancelled = true;
    await runPipeline("profile-1", "auto");
    expect(H.state.finished).toBeNull();
  });

  it("refuses to run at all for a manual 'Saved Jobs' container", async () => {
    H.state.isManual = true;
    await runPipeline("profile-1", "auto");
    // Bails before the run log is even created — no stages, no save, no writes.
    expect(H.state.stages).toEqual([]);
    expect(H.state.savedJobs).toBeNull();
    expect(H.state.finished).toBeNull();
    expect(H.state.writes).toEqual([]);
  });

  it("skips the run when another is already in flight", async () => {
    H.state.activeRuns = [{ id: "run-0", started_at: new Date().toISOString() }];
    await runPipeline("profile-1", "auto");
    expect(H.state.finished).toBeNull();
    expect(H.state.savedJobs).toBeNull();
  });
});

// ── A5. Call-order trace ──────────────────────────────────────────────────────
// The fifth window. The four above compare END STATE, which a moved operation
// can leave identical; this one pins the SEQUENCE. Mutation-tested: reordering
// visa extraction ahead of dedup is invisible to every other assertion here.
describe("A5. collaborator call order", () => {
  it("calls collaborators in a fixed sequence (legacy mode)", async () => {
    await runPipeline("profile-1", "auto");
    expect(H.state.trace).toEqual([
      "gate",
      "startRunLog",
      "fetch:adzuna",
      "fetch:careerjet",
      "fetch:seek-direct",
      "seekJd:3",
      "visa:3",
      "settings:3",
      "save:3",
      "autoAnalyze:3",
      "finishRunLog:completed",
      "recordCoverage",
    ]);
  });

  it("calls collaborators in a fixed sequence (bucket mode)", async () => {
    H.state.bucketOn = true;
    H.state.serveResult = [];
    await runPipeline("profile-1", "auto");
    expect(H.state.trace).toEqual([
      "gate",
      "bucketEvict",
      "startRunLog",
      "fetch:adzuna",
      "fetch:careerjet",
      "fetch:seek-direct",
      "seekJd:3",
      "visa:3",
      "settings:3",
      "bucketUpsert:3",
      "bucketServe",
      "save:0",
      "finishRunLog:completed",
      "recordCoverage",
    ]);
  });
});

// ── A6. Invariants the mutation battery proved were unguarded ─────────────────
describe("A6. filter-placement and new-vs-saved invariants", () => {
  // student_capped (capability 1) cannot meet a pr_citizen job (demand 3).
  const restrictive = () => {
    H.state.userVisaStatus = "student_capped";
    H.state.visaByTitle = { "Enrolled Nurse": "pr_citizen" };
  };

  it("legacy mode DOES apply the eligibility filter before saving", async () => {
    restrictive();
    await runPipeline("profile-1", "auto");
    expect(savedUrls()).toEqual([
      "https://www.adzuna.com.au/details/111",
      "https://www.seek.com.au/job/333",
    ]);
  });

  /**
   * BUCKET-POISONING INVARIANT: in bucket mode the per-user eligibility filter
   * must NOT run before the shared write, or one user's visa status would
   * strip jobs out of the bucket that other users are entitled to see. The
   * shared write must receive all 3.
   */
  it("bucket mode writes the UNFILTERED set to the shared bucket", async () => {
    restrictive();
    H.state.bucketOn = true;
    H.state.serveResult = [];
    await runPipeline("profile-1", "auto");
    expect(H.state.trace).toContain("bucketUpsert:3");
  });

  /**
   * Regression guard for 7ff73197: the notification must key off newSaved, not
   * saved — otherwise every re-scrape of still-live postings re-notifies.
   */
  it("does not queue a notification when nothing is genuinely new", async () => {
    H.state.newSaved = 0;
    await runPipeline("profile-1", "auto");
    expect(H.state.notified).toBeNull();
    expect(H.state.writes).not.toContain("pending_job_notifications.insert");
  });

  it("queues a notification counting only genuinely-new rows", async () => {
    H.state.newSaved = 1;
    await runPipeline("profile-1", "auto");
    expect(H.state.notified).toMatchObject({ jobs_saved: 1 });
  });
});
