import { describe, it, expect } from "vitest";
import { SETUP_STEPS, isSetupComplete, firstIncompleteStep } from "./setupSteps";
import type { SetupStatus } from "./setupStatus";

const FULL_STATUS: SetupStatus = {
  billing: true, details: true, cv: true, voice: true, aiKey: true,
  email: true, apify: true, searchProfile: true, hasAnyJob: false, hasProfile: true,
};

// C67: setupStatus.ts deliberately marks `searchProfile` done the instant
// the profile row exists ("creating the profile IS the onboarding task;
// running it isn't gated by setup") — the step's own instructions must not
// claim running the pipeline is also required to finish it, or the copy
// contradicts what the wizard actually checks.
describe("searchProfile step — instructions match the completion rule", () => {
  it("does not tell the user running is required to finish this step", () => {
    const step = SETUP_STEPS.find((s) => s.key === "searchProfile")!;
    expect(step.blurb.toLowerCase()).not.toMatch(/then hit run now|then run/);
  });

  it("isSetupComplete treats the required steps as satisfied with searchProfile=true and NO run yet (hasAnyJob=false)", () => {
    expect(isSetupComplete(FULL_STATUS)).toBe(true);
  });

  it("firstIncompleteStep does not park on searchProfile once its row exists, even with hasAnyJob=false", () => {
    expect(firstIncompleteStep(FULL_STATUS)).toBe(0);
  });
});
