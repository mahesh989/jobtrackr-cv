// @vitest-environment jsdom
/**
 * Autosave behaviour of the CV review editor.
 *
 * These tests exist to make ReviewClient safe to decompose. Its autosave is the
 * one place in this codebase where a mistake is SILENT: a stale closure, a
 * mis-ordered effect, or an uncleared timer does not throw — it just loses the
 * user's edits. Every assertion below pins a rule that a `useReviewAutosave`
 * extraction could plausibly break.
 *
 * Written BEFORE any refactor, against the pre-split component, so they
 * describe current behaviour rather than the behaviour of a new design.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StructuredCv } from "@/lib/cv/backend";

const AUTOSAVE_MS = 10_000;

// ── module mocks ─────────────────────────────────────────────────────────────
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

import { ReviewClient } from "./ReviewClient";

// ── fixtures ─────────────────────────────────────────────────────────────────
function baseCv(over: Partial<StructuredCv> = {}): StructuredCv {
  return {
    summary: "A summary.",
    skills: { domain_knowledge: [], soft_skills: [], technical: [] },
    experience: [{
      employer: "Acme", role: "Nurse", location: "Sydney",
      start_date: "2020", end_date: "2023", is_current: false,
      bullets: ["Delivered care."],
    }],
    education: [{
      institution: "TAFE", qualification: "Cert III", location: "Sydney",
      start_date: "2018", end_date: "2019", completed: true,
    }],
    certifications: [],
    references: [],
    ...over,
  } as unknown as StructuredCv;
}

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse() {
  return {
    ok: true,
    json: async () => ({ structured_cv_status: "in_review" }),
  };
}

function renderReview(props: Partial<Parameters<typeof ReviewClient>[0]> = {}) {
  return render(
    <ReviewClient
      cvId="cv-1"
      label="my-cv.pdf"
      initialStructuredCv={baseCv()}
      initialStatus="in_review"
      {...props}
    />,
  );
}

/** Type into the Employer field — the simplest way to make the doc dirty.
 *  Queried by label, not by current value, so repeated edits keep working. */
function editEmployer(value: string) {
  fireEvent.change(screen.getByLabelText(/^Employer/), { target: { value } });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

/** PATCH calls to the structured-CV endpoint (ignores unrelated fetches). */
function saveCalls() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes("/structured") && init?.method === "PATCH",
  );
}

function lastSavedPayload() {
  const calls = saveCalls();
  return JSON.parse(String(calls[calls.length - 1][1].body));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  push.mockClear();
  fetchMock = vi.fn(async () => okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── the debounce contract ────────────────────────────────────────────────────
describe("autosave debounce", () => {
  it("does not save on mount when nothing has changed", async () => {
    renderReview();
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS * 2); });
    expect(saveCalls()).toHaveLength(0);
  });

  it("saves once, AUTOSAVE_MS after an edit", async () => {
    renderReview();
    editEmployer("Acme Health");

    // Not yet — the debounce window has not elapsed.
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS - 1); });
    expect(saveCalls()).toHaveLength(0);

    await act(async () => { vi.advanceTimersByTime(2); });
    expect(saveCalls()).toHaveLength(1);
  });

  it("debounces a burst of edits into a single save carrying the LAST value", async () => {
    renderReview();
    editEmployer("A");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS - 100); });
    editEmployer("AB");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS - 100); });
    editEmployer("ABC");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });

    expect(saveCalls()).toHaveLength(1);
    // Stale-closure guard: the request must carry the newest text, not "A".
    expect(lastSavedPayload().structured_cv.experience[0].employer).toBe("ABC");
  });

  it("does not save again when a re-edit produces the already-saved value", async () => {
    renderReview();
    editEmployer("Changed");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(saveCalls()).toHaveLength(1);

    // Re-entering the SAME text the server just acknowledged is not a change.
    editEmployer("Changed");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS * 2); });
    expect(saveCalls()).toHaveLength(1);
  });

  it("DOES save again when the doc is reverted after a save", async () => {
    // lastSaved tracks the server-acknowledged payload, not the initial one, so
    // undoing an edit is itself a change that must be persisted.
    renderReview();
    editEmployer("Changed");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    editEmployer("Acme");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(saveCalls()).toHaveLength(2);
    expect(lastSavedPayload().structured_cv.experience[0].employer).toBe("Acme");
  });

  it("saves unverified — autosave never marks the CV reviewed", async () => {
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(lastSavedPayload().verified).toBe(false);
  });
});

// ── the dirty-flush contract ─────────────────────────────────────────────────
describe("dirty flush on teardown", () => {
  it("flushes pending edits when the component unmounts", async () => {
    const { unmount } = renderReview();
    editEmployer("Acme Health");
    // Well inside the debounce window — nothing written yet.
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(saveCalls()).toHaveLength(0);

    await act(async () => { unmount(); });

    expect(saveCalls()).toHaveLength(1);
    expect(lastSavedPayload().structured_cv.experience[0].employer).toBe("Acme Health");
    // keepalive is what lets the request survive the page going away.
    expect(saveCalls()[0][1].keepalive).toBe(true);
  });

  it("does NOT flush on unmount when nothing is dirty", async () => {
    const { unmount } = renderReview();
    await act(async () => { unmount(); });
    expect(saveCalls()).toHaveLength(0);
  });

  it("flushes the LATEST edit on unmount, not the first", async () => {
    const { unmount } = renderReview();
    editEmployer("first");
    await act(async () => { vi.advanceTimersByTime(50); });
    editEmployer("second");
    await act(async () => { unmount(); });

    // This is the `latest` ref's whole reason for existing: the unmount cleanup
    // registers once, so without it the closure would flush "first".
    expect(lastSavedPayload().structured_cv.experience[0].employer).toBe("second");
  });

  it("flushes when the tab is hidden", async () => {
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(100); });

    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0][1].keepalive).toBe(true);
  });

  it("ignores visibilitychange when the tab is becoming VISIBLE", async () => {
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(100); });

    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(saveCalls()).toHaveLength(0);
  });

  it("flushes on pagehide once the tab is hidden", async () => {
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(100); });
    // Browsers fire visibilitychange(hidden) before pagehide on a real unload.
    setVisibility("hidden");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(saveCalls()).toHaveLength(1);
  });

  it("pagehide alone does NOT flush while the tab is still visible", async () => {
    // Documents a real quirk: the pagehide listener shares flushIfHidden, which
    // early-returns unless visibilityState === "hidden". In practice the
    // visibilitychange handler has already flushed by then, and the unmount
    // cleanup covers in-app navigation — so pagehide is belt-and-braces only.
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(100); });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(saveCalls()).toHaveLength(0);
  });

  it("does not double-save when a flush is followed by unmount", async () => {
    const { unmount } = renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(100); });
    setVisibility("hidden");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(saveCalls()).toHaveLength(1);

    // The flush updated lastSaved, so unmount sees a clean doc.
    await act(async () => { unmount(); });
    expect(saveCalls()).toHaveLength(1);
  });

  it("does not fire the debounced save after a teardown flush", async () => {
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(100); });
    setVisibility("hidden");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    // The pending timer must have been cleared by the flush.
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS * 2); });
    expect(saveCalls()).toHaveLength(1);
  });
});

// ── create mode ──────────────────────────────────────────────────────────────
describe("create mode", () => {
  it("never autosaves — the user saves explicitly", async () => {
    renderReview({ mode: "create" });
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS * 3); });
    expect(saveCalls()).toHaveLength(0);
  });

  it("does not flush on unmount either", async () => {
    const { unmount } = renderReview({ mode: "create" });
    editEmployer("Acme Health");
    await act(async () => { unmount(); });
    expect(saveCalls()).toHaveLength(0);
  });
});

// ── failure handling ─────────────────────────────────────────────────────────
describe("save failure", () => {
  it("keeps the doc dirty after a failed save, so the next edit retries", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }));
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(saveCalls()).toHaveLength(1);

    // lastSaved must NOT have advanced — a further edit must try again.
    fetchMock.mockImplementation(async () => okResponse());
    editEmployer("Acme Health Group");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(saveCalls()).toHaveLength(2);
  });

  it("leaves the doc dirty after a failure — a teardown flush still fires", async () => {
    // Distinguishes "lastSaved advanced anyway" from "lastSaved held back".
    // Without a further edit, the only way the flush fires is if the failed
    // save correctly refused to advance the snapshot.
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 500, json: async () => ({ error: "boom" }),
    }));
    const { unmount } = renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(saveCalls()).toHaveLength(1);

    await act(async () => { unmount(); });
    expect(saveCalls()).toHaveLength(2);
    expect(saveCalls()[1][1].keepalive).toBe(true);
  });

  it("surfaces the server error message", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 500, json: async () => ({ error: "Disk full" }),
    }));
    renderReview();
    editEmployer("Acme Health");
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(screen.getAllByText(/Disk full/).length).toBeGreaterThan(0);
  });
});
