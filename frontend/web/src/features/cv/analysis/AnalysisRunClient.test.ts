/**
 * Regression tests for the "AnalysisRunClient polls forever on failed runs"
 * finding (24-col select / 3s, uncapped): the poll's settlement check
 * required `cover_letter_status` to be non-null before ever stopping, but a
 * run that fails BEFORE the orchestrator reaches its auto-cover-letter
 * decision leaves that column permanently NULL — only a COMPLETED run ever
 * gets one set. The fix ports the two guards useJobRunStatus.ts already had:
 * (1) a FAILED run settles immediately, no cover-letter wait; (2) a hard
 * time cap, so even a stuck 'triggered'-but-never-resolving cover letter
 * can't poll forever either.
 *
 * The polling effect itself (setInterval/Realtime/Supabase) is not
 * unit-testable without mounting the component — `isRunPollSettled` is the
 * pure decision it delegates to, extracted specifically so this bug (and
 * its fix) can be characterized directly.
 */
import { describe, it, expect } from "vitest";
import { isRunPollSettled, deriveCoverLetterStep } from "./AnalysisRunClient";

describe("isRunPollSettled", () => {
  it("REGRESSION: a failed run settles immediately, even with cover_letter_status still null", () => {
    // This is the exact bug: a run that fails before the orchestrator's
    // auto-cover-letter decision never gets cover_letter_status set at
    // all — the old logic required it to be non-null before stopping,
    // which for a failed run meant "never".
    expect(isRunPollSettled("failed", null, null)).toBe(true);
  });

  it("a failed run settles even if cover_letter_status somehow got set (defensive — should never happen for 'failed')", () => {
    expect(isRunPollSettled("failed", "triggered", null)).toBe(true);
  });

  it("a still-running/pending run never settles", () => {
    expect(isRunPollSettled("pending", null, null)).toBe(false);
    expect(isRunPollSettled("running", null, null)).toBe(false);
  });

  it("a completed run is NOT settled until cover_letter_status is recorded", () => {
    expect(isRunPollSettled("completed", null, null)).toBe(false);
  });

  it("a completed run with a skipped/failed cover-letter DECISION (not the row itself) settles immediately", () => {
    expect(isRunPollSettled("completed", "skipped:below_gate", null)).toBe(true);
    expect(isRunPollSettled("completed", "failed:no_voice", null)).toBe(true);
  });

  it("a completed+triggered run waits for the cover_letters row to reach a terminal status", () => {
    expect(isRunPollSettled("completed", "triggered", null)).toBe(false);
    expect(isRunPollSettled("completed", "triggered", "picking")).toBe(false);
    expect(isRunPollSettled("completed", "triggered", "completed")).toBe(true);
    expect(isRunPollSettled("completed", "triggered", "failed")).toBe(true);
  });
});

describe("deriveCoverLetterStep", () => {
  it("REGRESSION: a failed run with no cover-letter decision shows 'skipped', not the old dead-ternary 'pending'", () => {
    // The old code was `runIsTerminal ? "pending" : "pending"` — a literal
    // tell that this branch was never actually finished. "pending" on an
    // already-failed run misleadingly implied the cover letter was still
    // coming, when it can never generate for a failed run.
    expect(deriveCoverLetterStep(null, null, true)).toEqual({ state: "skipped" });
  });

  it("a still-running run with no decision yet shows 'pending'", () => {
    expect(deriveCoverLetterStep(null, null, false)).toEqual({ state: "pending" });
  });
});
