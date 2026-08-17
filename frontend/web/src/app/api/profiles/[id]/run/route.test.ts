import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const profileQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  profileQuery.select = vi.fn(() => profileQuery);
  profileQuery.eq = vi.fn(() => profileQuery);
  profileQuery.single = vi.fn();
  return {
    profileQuery,
    queueAdd: vi.fn(),
    queueGetJob: vi.fn(),
    queueClose: vi.fn(),
    redisQuit: vi.fn(),
    redisDisconnect: vi.fn(),
    queueConstructor: vi.fn(),
    consumeRun: vi.fn(),
    commitRunUsageEvent: vi.fn(),
    redisConstructor: vi.fn(),
  };
});

vi.mock("@/lib/api-utils", () => ({
  jsonError: (message: string, status: number) =>
    Response.json({ error: message }, { status }),
  withUser: (handler: (
    request: unknown,
    context: unknown,
    auth: { user: { id: string; email: string }; supabase: unknown },
  ) => Promise<Response>) =>
    (request: unknown, context: unknown) => handler(request, context, {
      user: { id: "user-1", email: "user@example.com" },
      supabase: { from: () => mocks.profileQuery },
    }),
}));

vi.mock("@/lib/rateLimit", () => ({
  RATE_LIMIT_MESSAGE: "rate limited",
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9 }),
}));

vi.mock("@/lib/billing/entitlements", () => ({
  consumeRun: mocks.consumeRun,
  commitRunUsageEvent: mocks.commitRunUsageEvent,
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn(function Redis(url: string, options: unknown) {
    mocks.redisConstructor(url, options);
    return { quit: mocks.redisQuit, disconnect: mocks.redisDisconnect };
  }),
}));
vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    mocks.queueConstructor();
    return { add: mocks.queueAdd, getJob: mocks.queueGetJob, close: mocks.queueClose };
  }),
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "profile-1" }) };
const requestId = "11111111-1111-4111-8111-111111111111";
const queueJobId = `run-user-1-${requestId}`;
const request = { json: vi.fn().mockResolvedValue({ fullRefresh: false, requestId }) };

describe("POST /api/profiles/[id]/run paid-run lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REDIS_URL = "rediss://example.invalid:6379";
    mocks.profileQuery.single.mockResolvedValue({
      data: { id: "profile-1", is_manual: false },
    });
    mocks.consumeRun.mockResolvedValue({ allowed: true, eventId: "evt-run-1" });
    mocks.queueGetJob.mockImplementation(async () => {
      if (mocks.queueAdd.mock.calls.length === 0) return undefined;
      return {
        id: queueJobId,
        data: {
          type: "run_profile",
          profileId: "profile-1",
          userId: "user-1",
          usageEventId: "evt-run-1",
          fullRefresh: false,
        },
      };
    });
    mocks.queueAdd.mockResolvedValue({ id: "job-1" });
    mocks.queueClose.mockResolvedValue(undefined);
    mocks.redisQuit.mockResolvedValue("OK");
    mocks.commitRunUsageEvent.mockResolvedValue(undefined);
  });

  it("commits the reservation only after the job is enqueued and always closes", async () => {
    const response = await POST(request as never, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, jobId: queueJobId });
    expect(mocks.consumeRun).toHaveBeenCalledWith(
      "user-1", requestId, "profile-1", false,
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "run_profile",
      expect.objectContaining({
        profileId: "profile-1",
        userId: "user-1",
        usageEventId: "evt-run-1",
      }),
      expect.objectContaining({ jobId: queueJobId }),
    );
    expect(mocks.commitRunUsageEvent).toHaveBeenCalledWith("evt-run-1");
    expect(mocks.queueClose).toHaveBeenCalledTimes(1);
    expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commitRunUsageEvent.mock.invocationCallOrder[0],
    );
  });

  it("keeps the reservation and request id when enqueue acknowledgement is ambiguous", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(request as never, context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Run start is uncertain. Please retry.",
      requestId,
    });
    expect(mocks.commitRunUsageEvent).not.toHaveBeenCalled();
    expect(mocks.queueClose).toHaveBeenCalledTimes(1);
    expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
  });

  it("keeps the request id when reservation acknowledgement is ambiguous", async () => {
    mocks.consumeRun.mockRejectedValue(new Error("run usage reservation uncertain"));

    const response = await POST(request as never, context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Run start is uncertain. Please retry.",
      requestId,
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("canonicalizes UUID casing and namespaces the BullMQ id by user", async () => {
    const upper = requestId.toUpperCase();
    const upperRequest = {
      json: vi.fn().mockResolvedValue({ fullRefresh: false, requestId: upper }),
    };

    const response = await POST(upperRequest as never, context);

    expect(response.status).toBe(200);
    expect(mocks.consumeRun).toHaveBeenCalledWith(
      "user-1", requestId, "profile-1", false,
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "run_profile",
      expect.anything(),
      expect.objectContaining({ jobId: `run-user-1-${requestId}` }),
    );
  });

  it("does not commit when post-add reconciliation finds different job data", async () => {
    mocks.queueGetJob
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: queueJobId,
        data: {
          type: "run_profile",
          profileId: "another-profile",
          userId: "user-1",
          usageEventId: "evt-run-1",
        },
      });

    const response = await POST(request as never, context);

    expect(response.status).toBe(503);
    expect(mocks.commitRunUsageEvent).not.toHaveBeenCalled();
  });

  it("waits for BullMQ's determinate result instead of voiding an ambiguous timeout", async () => {
    vi.useFakeTimers();
    mocks.queueAdd.mockReturnValue(new Promise((resolve) => {
      setTimeout(() => resolve({ id: "slow-job" }), 6000);
    }));

    const pending = POST(request as never, context);
    await vi.advanceTimersByTimeAsync(5000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;
    vi.useRealTimers();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, jobId: queueJobId });
    expect(mocks.commitRunUsageEvent).toHaveBeenCalledWith("evt-run-1");
    expect(mocks.queueClose).toHaveBeenCalledTimes(1);
    expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
  });

  it("disconnects Redis without reserving quota if Queue construction throws", async () => {
    mocks.queueConstructor.mockImplementationOnce(() => {
      throw new Error("invalid queue options");
    });

    const response = await POST(request as never, context);

    expect(response.status).toBe(503);
    expect(mocks.consumeRun).not.toHaveBeenCalled();
    expect(mocks.redisDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.queueClose).not.toHaveBeenCalled();
  });

  it("returns the successful job without inviting a duplicate when commit logging fails", async () => {
    mocks.commitRunUsageEvent.mockRejectedValue(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request as never, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, jobId: queueJobId });
    expect(errorSpy).toHaveBeenCalledWith(
      "[run] usage commit failed after enqueue:",
      "database unavailable",
    );
    errorSpy.mockRestore();
  });

  it("reconciles an existing job without reserving or enqueueing again", async () => {
    mocks.queueGetJob.mockResolvedValue({
      id: queueJobId,
      data: {
        type: "run_profile",
        profileId: "profile-1",
        userId: "user-1",
        usageEventId: "evt-run-1",
        fullRefresh: false,
      },
      getState: vi.fn().mockResolvedValue("waiting"),
      retry: vi.fn(),
    });

    const response = await POST(request as never, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, jobId: queueJobId });
    expect(mocks.consumeRun).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.commitRunUsageEvent).toHaveBeenCalledWith("evt-run-1");
  });

  it("repairs and retries a job that failed only because usage commit was unavailable", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValue({
      id: queueJobId,
      data: {
        type: "run_profile",
        profileId: "profile-1",
        userId: "user-1",
        usageEventId: "evt-run-1",
        fullRefresh: false,
      },
      failedReason: "run usage commit failed: database unavailable",
      getState: vi.fn().mockResolvedValue("failed"),
      retry,
    });

    const response = await POST(request as never, context);

    expect(response.status).toBe(200);
    expect(mocks.commitRunUsageEvent).toHaveBeenCalledWith("evt-run-1");
    expect(retry).toHaveBeenCalledWith("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("requires a fresh charged request after a genuine terminal pipeline failure", async () => {
    mocks.queueGetJob.mockResolvedValue({
      id: queueJobId,
      data: {
        type: "run_profile",
        profileId: "profile-1",
        userId: "user-1",
        usageEventId: "evt-run-1",
        fullRefresh: false,
      },
      failedReason: "source fetch exploded",
      getState: vi.fn().mockResolvedValue("failed"),
      retry: vi.fn(),
    });

    const response = await POST(request as never, context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The previous run failed. Retry to start a new run.",
      resetRequest: true,
    });
    expect(mocks.commitRunUsageEvent).not.toHaveBeenCalled();
  });

  it("does not alias incremental and full-refresh intents to one queue job", async () => {
    mocks.queueGetJob.mockResolvedValue({
      id: queueJobId,
      data: {
        type: "run_profile",
        profileId: "profile-1",
        userId: "user-1",
        usageEventId: "evt-run-1",
        fullRefresh: false,
      },
      getState: vi.fn().mockResolvedValue("waiting"),
    });
    const fullRequest = {
      json: vi.fn().mockResolvedValue({ fullRefresh: true, requestId }),
    };

    const response = await POST(fullRequest as never, context);

    expect(response.status).toBe(409);
    expect(mocks.commitRunUsageEvent).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("does not enqueue again when the durable request is already committed", async () => {
    mocks.consumeRun.mockResolvedValue({
      allowed: true,
      eventId: "evt-run-1",
      alreadyCommitted: true,
    });

    const response = await POST(request as never, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      jobId: queueJobId,
      alreadyProcessed: true,
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("rejects a reused request id whose durable intent differs", async () => {
    mocks.consumeRun.mockResolvedValue({
      allowed: false,
      reason: "run_cap",
      requestConflict: true,
    });

    const response = await POST(request as never, context);

    expect(response.status).toBe(409);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("bounds connected Redis commands as well as initial connection", async () => {
    await POST(request as never, context);

    expect(mocks.redisConstructor).toHaveBeenCalledWith(
      "rediss://example.invalid:6379",
      expect.objectContaining({ connectTimeout: 5000, commandTimeout: 5000 }),
    );
  });
});
