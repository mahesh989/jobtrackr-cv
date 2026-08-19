// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TailoredScoreCard } from "./TailoredScoreCard";

// C67: delta used to default a missing afterScore to 0 and subtract a real
// beforeScore from it — if tailoring simply hadn't finished computing
// tailored_match_score yet, this fabricated a dramatic negative "Lift"
// (e.g. "-70") implying tailoring made things worse, when nothing had
// actually been measured yet.

afterEach(() => {
  cleanup();
});

describe("TailoredScoreCard", () => {
  it("shows a neutral placeholder, not a fabricated negative lift, when afterScore isn't ready yet", () => {
    render(<TailoredScoreCard beforeScore={70} afterScore={null} />);
    expect(screen.queryByText("-70")).toBeFalsy();
    // The Lift badge specifically (text-h3), distinct from the Tailored
    // ScoreCircle (text-h1) which also legitimately shows "—" here.
    expect(screen.getByText("—", { selector: ".text-h3" })).toBeTruthy();
  });

  it("still shows a real negative lift when both scores are genuinely known and tailoring regressed", () => {
    render(<TailoredScoreCard beforeScore={70} afterScore={60} />);
    expect(screen.getByText("-10")).toBeTruthy();
  });

  it("shows a real positive lift when both scores are known", () => {
    render(<TailoredScoreCard beforeScore={60} afterScore={80} />);
    expect(screen.getByText("+20")).toBeTruthy();
  });

  it("an explicit lift prop always wins, even with a missing afterScore", () => {
    render(<TailoredScoreCard beforeScore={70} afterScore={null} lift={5} />);
    expect(screen.getByText("+5")).toBeTruthy();
  });
});
