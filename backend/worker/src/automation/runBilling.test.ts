import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rpc = vi.fn();
  return { rpc };
});

vi.mock("../db/client.js", () => ({ db: { rpc: mocks.rpc } }));

import { commitRunUsageEvent } from "./billing.js";

describe("manual-run billing finalisation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("commits the pending usage event and surfaces database failures", async () => {
    await expect(commitRunUsageEvent("evt-run-1")).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("commit_run_usage", { p_event: "evt-run-1" });

    mocks.rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    await expect(commitRunUsageEvent("evt-run-1")).rejects.toThrow("database unavailable");

    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(commitRunUsageEvent("evt-run-1")).rejects.toThrow("not pending or committed");
  });

  it("keeps worker startup wired to commit before paid pipeline execution", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const commitAt = source.indexOf("await commitRunUsageEvent(job.data.usageEventId)");
    const pipelineAt = source.indexOf("await runPipeline(job.data.profileId");
    expect(commitAt).toBeGreaterThan(-1);
    expect(pipelineAt).toBeGreaterThan(commitAt);
  });
});
