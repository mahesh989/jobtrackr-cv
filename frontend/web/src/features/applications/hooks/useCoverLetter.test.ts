// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCoverLetter } from "./useCoverLetter";

// C67: the letterId re-arm logic unconditionally wiped text/saved to "" on
// ANY letterId change — including CoverLetterTab's `sent ? null :
// letter.id` mapping, which passes null the instant a letter transitions
// to sent (e.g. a Realtime update from another tab). A user with an
// in-progress unsaved edit at that exact moment had it silently destroyed
// with zero warning.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ pass_3_final: "Original saved text" }),
  }));
});

describe("useCoverLetter — unsaved edits vs a letterId change", () => {
  it("preserves an in-progress unsaved edit when letterId transitions to null (e.g. the letter just got sent)", async () => {
    const { result, rerender } = renderHook(
      ({ letterId }: { letterId: string | null }) => useCoverLetter(letterId),
      { initialProps: { letterId: "letter-1" as string | null } },
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.text).toBe("Original saved text");

    act(() => result.current.setText("My unsaved in-progress edit"));
    expect(result.current.dirty).toBe(true);

    rerender({ letterId: null });

    expect(result.current.text).toBe("My unsaved in-progress edit");
  });

  it("still clears cleanly when there was no unsaved edit to lose", async () => {
    const { result, rerender } = renderHook(
      ({ letterId }: { letterId: string | null }) => useCoverLetter(letterId),
      { initialProps: { letterId: "letter-1" as string | null } },
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.dirty).toBe(false);

    rerender({ letterId: null });

    expect(result.current.text).toBe("");
  });
});
