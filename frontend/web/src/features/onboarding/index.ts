/**
 * Public interface of the onboarding feature — exactly the symbols the app/
 * pages consume. Feature internals stay importable only by path (and
 * cross-feature imports deliberately stay direct to avoid module cycles).
 */
export { HowItWorksDeck } from "./HowItWorksDeck";
export { InstructionsTabs } from "./InstructionsTabs";
export { SetupStepperBar } from "./SetupStepperBar";
