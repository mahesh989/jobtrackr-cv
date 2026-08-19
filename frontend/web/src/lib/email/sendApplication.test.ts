/**
 * Regression tests for B2-P2 (audit): sendApplicationEmail's post-send
 * bookkeeping (email_sent_at/email_sent_to on cover_letters, applied_at on
 * jobs) was fired via a bare `Promise.all([...])` with no {error} check at
 * all. The email has already been irreversibly sent by that point, so a
 * silent DB failure isn't just a display nit — pipelineState.ts keys a
 * job's "applied" state solely off jobs.applied_at, so a job whose stamp
 * silently failed keeps showing as unapplied, inviting the user to
 * generate and send a SECOND cover letter/email for a job an employer was
 * already emailed about (the earlier per-letter claim only blocks a retry
 * of the SAME letter_id, not a brand-new one).
 */
import { describe, it, expect, vi } from "vitest";
import { recordSentStamps } from "./sendApplication";

type UpdateResult = { error: { message: string } | null };

function fakeAdmin(results: { letters: UpdateResult; jobs: UpdateResult }) {
  const calls: Array<{ table: string; payload: unknown; id: string }> = [];
  return {
    admin: {
      from(table: string) {
        return {
          update(payload: unknown) {
            return {
              async eq(_col: string, id: string) {
                calls.push({ table, payload, id });
                return table === "cover_letters" ? results.letters : results.jobs;
              },
            };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    calls,
  };
}

describe("recordSentStamps", () => {
  it("stamps both cover_letters and jobs when both writes succeed", async () => {
    const { admin, calls } = fakeAdmin({ letters: { error: null }, jobs: { error: null } });

    const result = await recordSentStamps(admin, {
      letterId: "letter-1",
      jobId:    "job-1",
      sentTo:   "hiring@acme.example",
      sentAt:   "2026-08-13T00:00:00.000Z",
    });

    expect(result).toEqual({ letterStampOk: true, jobStampOk: true });
    expect(calls).toEqual([
      { table: "cover_letters", payload: { email_sent_at: "2026-08-13T00:00:00.000Z", email_sent_to: "hiring@acme.example" }, id: "letter-1" },
      { table: "jobs", payload: { applied_at: "2026-08-13T00:00:00.000Z" }, id: "job-1" },
    ]);
  });

  it("REGRESSION: a failed jobs.applied_at write is surfaced (not silently swallowed) — this is the double-send risk", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({
      letters: { error: null },
      jobs: { error: { message: "connection reset" } },
    });

    const result = await recordSentStamps(admin, {
      letterId: "letter-1",
      jobId:    "job-1",
      sentTo:   "hiring@acme.example",
      sentAt:   "2026-08-13T00:00:00.000Z",
    });

    expect(result).toEqual({ letterStampOk: true, jobStampOk: false });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("jobs.applied_at"),
      "connection reset",
    );
    errSpy.mockRestore();
  });

  it("REGRESSION: a failed cover_letters stamp write is surfaced independently of the jobs write's outcome", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({
      letters: { error: { message: "unique constraint violation" } },
      jobs: { error: null },
    });

    const result = await recordSentStamps(admin, {
      letterId: "letter-1",
      jobId:    "job-1",
      sentTo:   "hiring@acme.example",
      sentAt:   "2026-08-13T00:00:00.000Z",
    });

    expect(result).toEqual({ letterStampOk: false, jobStampOk: true });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("cover_letters"),
      "unique constraint violation",
    );
    errSpy.mockRestore();
  });

  it("both failures are independently surfaced when both writes fail", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({
      letters: { error: { message: "letters down" } },
      jobs: { error: { message: "jobs down" } },
    });

    const result = await recordSentStamps(admin, {
      letterId: "letter-1",
      jobId:    "job-1",
      sentTo:   null,
      sentAt:   "2026-08-13T00:00:00.000Z",
    });

    expect(result).toEqual({ letterStampOk: false, jobStampOk: false });
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});
