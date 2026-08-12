/**
 * Regression tests for B4-P2 (audit): LoginForm.tsx's `?next=` guard was a
 * manual string check (`startsWith("/") && !startsWith("//")`) that blocked
 * `//evil.com` but missed `/\evil.com` — the WHATWG URL parser (the same
 * one the browser uses to resolve `window.location.href = next`) treats a
 * leading backslash like a leading slash and resolves it off-origin anyway.
 */
import { describe, it, expect } from "vitest";
import { sanitizeNextPath } from "./safeRedirect";

describe("sanitizeNextPath", () => {
  it("REGRESSION (B4-P2): blocks the backslash bypass that defeated the old startsWith guard", () => {
    expect(sanitizeNextPath("/\\evil.com")).toBe("/");
    expect(sanitizeNextPath("/\\\\evil.com")).toBe("/");
  });

  it("blocks a protocol-relative URL", () => {
    expect(sanitizeNextPath("//evil.com")).toBe("/");
    expect(sanitizeNextPath("//evil.com/path")).toBe("/");
  });

  it("blocks an absolute off-origin URL", () => {
    expect(sanitizeNextPath("https://evil.com")).toBe("/");
    expect(sanitizeNextPath("http://evil.com/phish")).toBe("/");
  });

  it("blocks a javascript: URL", () => {
    expect(sanitizeNextPath("javascript:alert(document.cookie)")).toBe("/");
  });

  it("blocks a data: URL", () => {
    expect(sanitizeNextPath("data:text/html,<script>alert(1)</script>")).toBe("/");
  });

  it("blocks a leading-whitespace bypass attempt", () => {
    expect(sanitizeNextPath("  //evil.com")).toBe("/");
    expect(sanitizeNextPath("\t/\\evil.com")).toBe("/");
  });

  it("allows a legitimate same-origin path", () => {
    expect(sanitizeNextPath("/pricing")).toBe("/pricing");
    expect(sanitizeNextPath("/onboarding/plan")).toBe("/onboarding/plan");
  });

  it("allows a same-origin path with query string and hash", () => {
    expect(sanitizeNextPath("/dashboard?tab=x#section")).toBe("/dashboard?tab=x#section");
  });

  it("falls back to '/' for null, undefined, or empty input", () => {
    expect(sanitizeNextPath(null)).toBe("/");
    expect(sanitizeNextPath(undefined)).toBe("/");
    expect(sanitizeNextPath("")).toBe("/");
  });

  it("a bare relative path with no leading slash resolves harmlessly as a same-origin path, not a redirect", () => {
    // "evil.com" here is just a path segment, not a host — new URL() resolves
    // it against the origin's root, same as any other relative path would.
    expect(sanitizeNextPath("evil.com")).toBe("/evil.com");
  });
});
