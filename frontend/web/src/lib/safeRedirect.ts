/**
 * Sanitize a `?next=` redirect target so it can never leave this origin.
 *
 * B4-P2 (audit): the previous guard was a manual string check —
 * `raw.startsWith("/") && !raw.startsWith("//")` — meant to block a
 * protocol-relative URL like `//evil.com` (which browsers navigate to as
 * `https://evil.com`). It missed `/\evil.com`: that string does NOT start
 * with `//`, so it passed the guard, but the WHATWG URL parser (the same
 * parser browsers use to resolve `window.location.href = next`) treats a
 * leading backslash the same as a leading slash and resolves it to
 * `https://evil.com/` anyway — proved with `new URL("/\\evil.com",
 * "https://jobtrackr.com.au")`. Any authenticated user could be phished
 * with a link to the real login page (`/auth/login?next=/\evil.com`),
 * sign in normally trusting the real domain, and be immediately redirected
 * to an attacker-controlled site.
 *
 * Rather than add another string-prefix special case (the exact class of
 * bug this is — the escape trick that works today, but a future one won't
 * be anticipated), this parses `next` with the SAME URL parser the browser
 * uses and only accepts it if the resolved origin is unchanged. That closes
 * this bug and the same class of bug for any other backslash/whitespace/
 * encoding trick, not just the one instance found.
 */
const SAME_ORIGIN_PLACEHOLDER = "https://same-origin.invalid";

export function sanitizeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  let resolved: URL;
  try {
    resolved = new URL(raw, SAME_ORIGIN_PLACEHOLDER);
  } catch {
    return "/";
  }
  if (resolved.origin !== SAME_ORIGIN_PLACEHOLDER) return "/";
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return path || "/";
}
