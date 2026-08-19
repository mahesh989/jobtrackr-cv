// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ToggleSwitch } from "./ToggleSwitch";

// C67: role="switch" had no accessible-name path — a screen reader
// announced only "switch, on/off" with no indication of what it controls,
// since the knob is purely decorative (no text content of its own).

afterEach(() => {
  cleanup();
});

describe("ToggleSwitch", () => {
  it("exposes the passed ariaLabel as the switch's accessible name", () => {
    render(<ToggleSwitch checked={false} onChange={vi.fn()} ariaLabel="Email me when new jobs are found" />);
    expect(screen.getByRole("switch", { name: "Email me when new jobs are found" })).toBeTruthy();
  });
});
