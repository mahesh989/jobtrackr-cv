// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { RunNowButton } from "./RunNowButton";

describe("RunNowButton request idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reuses the same request UUID and refresh mode after an uncertain response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "uncertain" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, jobId: "job-1" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<RunNowButton profileId="profile-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await screen.findByRole("button", { name: "Retry" });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstBody.fullRefresh).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody).toEqual(firstBody);
  });

  it("uses a fresh UUID after the server identifies a terminal request conflict", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ resetRequest: true }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ok: true, jobId: "job-2" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<RunNowButton profileId="profile-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Full refresh" }));
    await screen.findByRole("button", { name: "Retry" });
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(first.fullRefresh).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));

    expect(second.requestId).not.toBe(first.requestId);
    expect(second.fullRefresh).toBe(true);
  });
});
