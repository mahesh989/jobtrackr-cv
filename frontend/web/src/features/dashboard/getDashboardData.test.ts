/**
 * Unit tests for the pure half of the dashboard data layer.
 *
 * These pin behaviour that was previously inline in the route file and had NO
 * coverage of any kind — the dashboard's counts, the ?status=new narrowing, and
 * the per-vertical threshold resolution. Several assertions encode invariants
 * that past bugfixes established; those are marked REGRESSION.
 *
 * getDashboardData itself (the orchestrator) is not tested here: it needs a
 * Supabase client and is I/O. What it does beyond calling these helpers is
 * query construction, which a mock would only re-assert tautologically.
 */
import { describe, it, expect } from "vitest";
import {
  resolveProfileThresholds,
  readMyCvVerticals,
  mergeActionedJobs,
  narrowToLatestFetch,
  computeFunnelCounts,
  computeLensData,
  type DashboardProfile,
  type AllCountRow,
  type ActiveJobRow,
} from "./getDashboardData";

const profile = (over: Partial<DashboardProfile> & { id: string }): DashboardProfile => ({
  name: `Profile ${over.id}`, is_active: true, keywords: [], location: "Sydney",
  schedule_cron: "0 9 * * *", target_verticals: null, adzuna_exclude_keywords: null,
  ...over,
});

const row = (over: Partial<AllCountRow> & { id: string; profile_id: string }): AllCountRow => ({
  seen_at: "2026-01-01", applied_at: null, dismissed_at: null, starred_at: null,
  jd_quality: null, manual_jd_text: null, role_match: null, has_email: null,
  ...over,
});

// ── Threshold resolution ─────────────────────────────────────────────────────
describe("resolveProfileThresholds", () => {
  it("falls back to the global 60/70 with no verticals anywhere", () => {
    const t = resolveProfileThresholds([profile({ id: "p1" })], []);
    expect(t.get("p1")).toEqual({ initial: 60, final: 70 });
  });

  it("applies the healthcare override from per-profile target_verticals", () => {
    const t = resolveProfileThresholds([profile({ id: "p1", target_verticals: ["healthcare"] })], []);
    expect(t.get("p1")).toEqual({ initial: 40, final: 60 });
  });

  /**
   * REGRESSION: "healthcare" (sourcing) and "nursing" (My CV role_family) are
   * different strings for the same sector. Keying only one made nursing CVs
   * silently fall back to 60/70 — the "57% stopped at the 60% gate" bug.
   */
  it("treats the nursing role_family the same as the healthcare vertical", () => {
    const t = resolveProfileThresholds([profile({ id: "p1" })], ["nursing"]);
    expect(t.get("p1")).toEqual({ initial: 40, final: 60 });
  });

  it("lets the My CV vertical WIN over the profile's own target_verticals", () => {
    // My CV says nursing (40/60); the profile says something with no override.
    const t = resolveProfileThresholds(
      [profile({ id: "p1", target_verticals: ["tech"] })],
      ["nursing"],
    );
    expect(t.get("p1")).toEqual({ initial: 40, final: 60 });
  });

  it("resolves each profile independently", () => {
    const t = resolveProfileThresholds([
      profile({ id: "p1", target_verticals: ["healthcare"] }),
      profile({ id: "p2", target_verticals: ["tech"] }),
    ], []);
    expect(t.get("p1")).toEqual({ initial: 40, final: 60 });
    expect(t.get("p2")).toEqual({ initial: 60, final: 70 });
  });
});

describe("readMyCvVerticals", () => {
  it("returns [] for a missing prefs row", () => {
    expect(readMyCvVerticals(null)).toEqual([]);
  });
  it("drops empty entries", () => {
    expect(readMyCvVerticals({ contact_details: { role_families: ["nursing", "", null] } }))
      .toEqual(["nursing"]);
  });
});

// ── Acted-on merge ───────────────────────────────────────────────────────────
describe("mergeActionedJobs", () => {
  const j = (id: string): ActiveJobRow => ({ id, profile_id: "p1" });

  it("appends acted-on rows the capped page missed", () => {
    const out = mergeActionedJobs([j("a")], [j("b")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("never duplicates a job present in both queries", () => {
    const out = mergeActionedJobs([j("a"), j("b")], [j("b"), j("c")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the capped page's copy first (its row wins)", () => {
    const capped = { id: "a", profile_id: "p1", title: "from-capped" };
    const acted = { id: "a", profile_id: "p1", title: "from-acted" };
    expect(mergeActionedJobs([capped], [acted])[0].title).toBe("from-capped");
  });
});

// ── ?status=new narrowing ────────────────────────────────────────────────────
describe("narrowToLatestFetch", () => {
  const T0 = "2026-01-01T00:00:00Z";
  const T1 = "2026-02-01T00:00:00Z";
  const T2 = "2026-03-01T00:00:00Z";

  it("keeps every job for a profile with no completed run (first fetch IS the batch)", () => {
    const jobs: ActiveJobRow[] = [
      { id: "a", profile_id: "p1", created_at: T0 },
      { id: "b", profile_id: "p1", created_at: T2 },
    ];
    expect(narrowToLatestFetch(jobs, []).map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("keeps only jobs created at or after the newest run that actually found something", () => {
    const jobs: ActiveJobRow[] = [
      { id: "old", profile_id: "p1", created_at: T0 },
      { id: "new", profile_id: "p1", created_at: T2 },
    ];
    // Newest-first, as the query returns them.
    const runs = [
      { profile_id: "p1", started_at: T2 },
      { profile_id: "p1", started_at: T1 },
    ];
    expect(narrowToLatestFetch(jobs, runs).map((j) => j.id)).toEqual(["new"]);
  });

  /**
   * The floor is the newest run that FOUND something. A run that returned
   * nothing must not blank the view — it falls through to the previous run.
   */
  it("skips an empty newest run and floors on the previous productive one", () => {
    const jobs: ActiveJobRow[] = [
      { id: "old", profile_id: "p1", created_at: T0 },
      { id: "mid", profile_id: "p1", created_at: T1 },
    ];
    const runs = [
      { profile_id: "p1", started_at: T2 },   // found nothing
      { profile_id: "p1", started_at: T1 },   // found "mid"
    ];
    expect(narrowToLatestFetch(jobs, runs).map((j) => j.id)).toEqual(["mid"]);
  });

  it("floors each profile independently", () => {
    const jobs: ActiveJobRow[] = [
      { id: "p1-old", profile_id: "p1", created_at: T0 },
      { id: "p1-new", profile_id: "p1", created_at: T2 },
      { id: "p2-old", profile_id: "p2", created_at: T0 },
    ];
    const runs = [{ profile_id: "p1", started_at: T2 }];
    // p2 has no run at all, so it keeps everything.
    expect(narrowToLatestFetch(jobs, runs).map((j) => j.id).sort())
      .toEqual(["p1-new", "p2-old"]);
  });

  it("ignores unparseable run timestamps", () => {
    const jobs: ActiveJobRow[] = [{ id: "a", profile_id: "p1", created_at: T0 }];
    expect(narrowToLatestFetch(jobs, [{ profile_id: "p1", started_at: "not-a-date" }])
      .map((j) => j.id)).toEqual(["a"]);
  });
});

// ── Funnel counts ────────────────────────────────────────────────────────────
describe("computeFunnelCounts", () => {
  const th = new Map([["p1", { initial: 60, final: 70 }]]);

  it("counts discovered as non-dismissed rows only", () => {
    const c = computeFunnelCounts({
      allRows: [
        row({ id: "a", profile_id: "p1" }),
        row({ id: "b", profile_id: "p1", dismissed_at: "2026-01-02" }),
      ],
      runsData: [], lettersData: [], threshByProfile: th, totalNew: 0,
    });
    expect(c.discovered).toBe(1);
    expect(c.dismissed).toBe(1);
  });

  /**
   * REGRESSION: a dismissed+applied job is not visible in the Applied stage
   * view (the server filters dismissed_at IS NULL), so the chip must not count
   * it or the number disagrees with the list.
   */
  it("excludes dismissed jobs from the applied count", () => {
    const c = computeFunnelCounts({
      allRows: [
        row({ id: "a", profile_id: "p1", applied_at: "2026-01-02" }),
        row({ id: "b", profile_id: "p1", applied_at: "2026-01-02", dismissed_at: "2026-01-03" }),
      ],
      runsData: [], lettersData: [], threshByProfile: th, totalNew: 0,
    });
    expect(c.applied).toBe(1);
  });

  /**
   * "Below ATS" is recomputed LIVE from stored scores against the CURRENT
   * thresholds, never from the frozen passed_*_gate booleans — so lowering a
   * threshold re-buckets jobs with no re-analysis.
   */
  it("recomputes the below-threshold band live from the profile's thresholds", () => {
    const rows = [row({ id: "a", profile_id: "p1" })];
    const runs = [{ job_id: "a", initial_ats_score: 50, tailored_match_score: null }];

    const strict = computeFunnelCounts({
      allRows: rows, runsData: runs, lettersData: [],
      threshByProfile: new Map([["p1", { initial: 60, final: 70 }]]), totalNew: 0,
    });
    expect(strict.belowThreshold).toBe(1);   // 50 < 60

    const lenient = computeFunnelCounts({
      allRows: rows, runsData: runs, lettersData: [],
      threshByProfile: new Map([["p1", { initial: 40, final: 60 }]]), totalNew: 0,
    });
    expect(lenient.belowThreshold).toBe(0);  // 50 >= 40, same stored score
  });

  it("counts cvReady only for runs carrying a stored CV/PDF path", () => {
    const c = computeFunnelCounts({
      allRows: [row({ id: "a", profile_id: "p1" }), row({ id: "b", profile_id: "p1" })],
      runsData: [
        { job_id: "a", tailored_pdf_storage_path: "x.pdf" },
        { job_id: "b" },
      ],
      lettersData: [], threshByProfile: th, totalNew: 0,
    });
    expect(c.analysed).toBe(2);
    expect(c.cvReady).toBe(1);
  });

  /**
   * thinJd uses jobNeedsJd (thin AND no usable pasted JD), NOT the raw
   * jd_quality === "thin" count — a user who already pasted a JD has nothing
   * left to do, so the chip and the /?triage=thinJd destination must agree.
   */
  it("does not count a thin JD the user has already pasted text for", () => {
    const c = computeFunnelCounts({
      allRows: [
        row({ id: "a", profile_id: "p1", jd_quality: "thin" }),
        row({ id: "b", profile_id: "p1", jd_quality: "thin", manual_jd_text: "x".repeat(5000) }),
      ],
      runsData: [], lettersData: [], threshByProfile: th, totalNew: 0,
    });
    expect(c.thinJd).toBe(1);
    expect(c.richJd).toBe(1);   // the pasted one counts as rich-enough
  });

  it("passes totalNew straight through as newCount", () => {
    const c = computeFunnelCounts({
      allRows: [], runsData: [], lettersData: [], threshByProfile: th, totalNew: 7,
    });
    expect(c.newCount).toBe(7);
  });
});

// ── Donut lens data ──────────────────────────────────────────────────────────
describe("computeLensData", () => {
  const base = {
    ids: ["p1"],
    profileNameById: new Map([["p1", "Nursing"]]),
    activeJobRows: [] as AllCountRow[],
    runLogData: [],
    donutRunData: [],
    donutLetterData: [],
    threshByProfile: new Map([["p1", { initial: 60, final: 70 }]]),
    thinJdCount: 0,
  };

  it("splits sourcing into saved / deduped / filtered for a modern run", () => {
    const d = computeLensData({
      ...base,
      runLogData: [{
        profile_id: "p1", jobs_fetched: 100, jobs_after_dedup: null,
        jobs_saved: 60, jobs_deduped: 30, sources_saved: { seek: 60 },
      }],
    });
    expect(d.sourcing.fetched).toBe(100);
    expect(d.sourcing.totals).toEqual([60, 30, 10]);   // saved, dupes, 100-30-60
    expect(d.sourcing.byProfile[0].sourcesSaved).toEqual({ seek: 60 });
  });

  it("lumps pre-migration runs (null jobs_deduped) entirely into filtered", () => {
    const d = computeLensData({
      ...base,
      runLogData: [{
        profile_id: "p1", jobs_fetched: 100, jobs_after_dedup: null,
        jobs_saved: 60, jobs_deduped: null, sources_saved: null,
      }],
    });
    expect(d.sourcing.totals).toEqual([60, 0, 40]);
  });

  it("never lets a negative filtered count appear", () => {
    const d = computeLensData({
      ...base,
      runLogData: [{
        profile_id: "p1", jobs_fetched: 10, jobs_after_dedup: null,
        jobs_saved: 60, jobs_deduped: 30, sources_saved: null,
      }],
    });
    expect(d.sourcing.totals[2]).toBe(0);
  });

  it("buckets JD readiness as rich / thin / unknown", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [
        row({ id: "a", profile_id: "p1", jd_quality: "rich" }),
        row({ id: "b", profile_id: "p1", jd_quality: "thin" }),
        row({ id: "c", profile_id: "p1", jd_quality: null }),
      ],
    });
    expect(d.jd.totals).toEqual([1, 1, 1]);
  });

  it("buckets the ATS lens by live-recomputed gates", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [
        row({ id: "a", profile_id: "p1" }),
        row({ id: "b", profile_id: "p1" }),
        row({ id: "c", profile_id: "p1" }),
      ],
      donutRunData: [
        { job_id: "a", initial_ats_score: 80, tailored_match_score: 90, passed_initial_gate: null, passed_final_gate: null, ats_lift: 10, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: null },
        { job_id: "b", initial_ats_score: 65, tailored_match_score: null, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: null },
        { job_id: "c", initial_ats_score: 20, tailored_match_score: null, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: null },
      ],
    });
    expect(d.ats.totals).toEqual([1, 1, 1]);   // above final, below final, below initial
    expect(d.analysis.avgAtsLift).toBe(10);
  });

  it("keeps only the FIRST run per job (query is newest-first)", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [row({ id: "a", profile_id: "p1" })],
      donutRunData: [
        { job_id: "a", initial_ats_score: 90, tailored_match_score: 90, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: "2026-03-01" },
        { job_id: "a", initial_ats_score: 10, tailored_match_score: 10, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: "2026-01-01" },
      ],
    });
    expect(d.ats.totals).toEqual([1, 0, 0]);   // newest (90) wins, not the stale 10
  });

  it("counts a passed-final job with no letter and no application as a callout", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [row({ id: "a", profile_id: "p1" })],
      donutRunData: [
        { job_id: "a", initial_ats_score: 80, tailored_match_score: 90, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: null },
      ],
    });
    expect(d.callouts.passedButNoLetter).toBe(1);
  });

  it("does not flag a passed-final job the user already applied to", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [row({ id: "a", profile_id: "p1", applied_at: "2026-03-02" })],
      donutRunData: [
        { job_id: "a", initial_ats_score: 80, tailored_match_score: 90, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: null },
      ],
    });
    expect(d.callouts.passedButNoLetter).toBe(0);
  });

  /**
   * REGRESSION: the callout must use the same bar as the Thin JD chip
   * (jobNeedsJd), not jdTotals[1] — which counts every 'thin' job even when the
   * user already pasted a usable JD, so the callout disagreed with the filter
   * it links to.
   */
  it("takes thinJdCount from the funnel, not from the JD lens bucket", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [
        row({ id: "a", profile_id: "p1", jd_quality: "thin" }),
        row({ id: "b", profile_id: "p1", jd_quality: "thin" }),
      ],
      thinJdCount: 1,
    });
    expect(d.jd.totals[1]).toBe(2);          // two jobs classified thin
    expect(d.callouts.thinJdCount).toBe(1);  // but only one still needs action
  });

  it("omits profiles with no data from the byProfile breakdowns", () => {
    const d = computeLensData({ ...base, ids: ["p1", "p2"] });
    expect(d.jd.byProfile).toEqual([]);
    expect(d.analysis.byProfile).toEqual([]);
  });

  it("reports avgAtsLift as null when no run carries a lift", () => {
    const d = computeLensData({
      ...base,
      activeJobRows: [row({ id: "a", profile_id: "p1" })],
      donutRunData: [
        { job_id: "a", initial_ats_score: 80, tailored_match_score: null, passed_initial_gate: null, passed_final_gate: null, ats_lift: null, tailored_pdf_storage_path: null, tailored_cv_storage_path: null, created_at: null },
      ],
    });
    expect(d.analysis.avgAtsLift).toBeNull();
  });
});
