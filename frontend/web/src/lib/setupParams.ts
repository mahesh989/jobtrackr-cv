import type { ReadonlyURLSearchParams } from "next/navigation";

/**
 * Preserve the guided-setup wizard context (?setup=1&step=N) across an
 * in-app navigation. Without this, any redirect issued while ?setup=1 is
 * active (CV review → "Back to Profile", auto-proceed after upload, profile
 * creation, etc.) silently drops the user out of the wizard: the next page
 * loses its stepper bar and — worse — the SetupGateClient no longer
 * recognises them as "mid-wizard", so it can bounce them right back to
 * /instructions.
 *
 * No-op when the current URL isn't carrying ?setup=1.
 */
export function withSetupParams(to: string, searchParams: ReadonlyURLSearchParams): string {
  if (searchParams.get("setup") !== "1") return to;
  const step = searchParams.get("step");
  const suffix = `setup=1${step ? `&step=${step}` : ""}`;

  // A query string must precede any hash fragment ("/cv?setup=1#cv-<id>",
  // never "/cv#cv-<id>?setup=1") — split the hash off first so it's always
  // re-appended last, regardless of whether the caller passed one.
  const hashIdx = to.indexOf("#");
  const path = hashIdx === -1 ? to : to.slice(0, hashIdx);
  const hash = hashIdx === -1 ? "" : to.slice(hashIdx);
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${suffix}${hash}`;
}
