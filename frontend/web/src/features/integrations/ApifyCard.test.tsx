// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApifyCard } from "./ApifyCard";

// C67: handleDisconnect cleared `data` (reporting "disconnected") regardless
// of the DELETE response — a failed disconnect (network error, 500) looked
// identical to a successful one, leaving the card showing disconnected while
// the token was in fact still connected server-side.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONNECTED: React.ComponentProps<typeof ApifyCard>["initialData"] = {
  connected: true,
  status: "valid",
  status_reason: null,
  quota_used_usd: 1,
  quota_used_requests: 10,
  quota_remaining_usd: 4,
  monthly_budget_usd: 5,
  quota_resets_on: "2026-09-01",
  last_used_at: null,
  is_enabled: true,
};

describe("ApifyCard — disconnect error handling", () => {
  it("stays connected and shows an error when the DELETE request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Server error" }),
    }));

    render(<ApifyCard initialData={CONNECTED} />);

    await act(async () => {
      screen.getByText("Disconnect").click();
    });

    await waitFor(() => expect(screen.getByText("Server error")).toBeTruthy());
    expect(screen.getByText("Disconnect")).toBeTruthy();
  });

  it("clears the connected state when the DELETE request succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    render(<ApifyCard initialData={CONNECTED} />);

    await act(async () => {
      screen.getByText("Disconnect").click();
    });

    await waitFor(() => expect(screen.queryByText("Disconnect")).toBeFalsy());
  });
});
