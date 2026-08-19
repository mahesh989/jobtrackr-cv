/**
 * C67: this actor's own consumer (sources/seek.ts) declares listingDate as
 * an ISO date string BY CONTRACT ("// ISO date string (NOT 'featured' —
 * filtered at actor level)") and does `new Date(item.listingDate).toISOString()`
 * on it directly — but the card's date element (verified live against
 * seek.com.au, 2026-08) is a plain <div> with no datetime attribute, only
 * human-readable relative text: "16m ago", "8h ago", "9d ago•Expiring".
 * `new Date("9d ago")` is Invalid Date, so posted_at silently came out null
 * for essentially every actor-sourced SEEK job. "Featured" (SEEK's own
 * non-date placeholder for promoted listings) is passed through UNCHANGED
 * — the consumer already special-cases that exact string; converting it
 * here would break that filter. Anything else unrecognised also passes
 * through unchanged (same as today — the consumer's existing try/catch
 * still degrades an unparseable string to null, so this is strictly
 * additive, never a regression).
 *
 * Kept in its own dependency-free module (no apify/crawlee/playwright
 * imports) so it can be unit tested directly.
 */
const RELATIVE_DATE_RE = /^(\d+)\s*(m|h|d)\b/i;
const MS_PER_UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseListingDateToIso(raw: string, now: number = Date.now()): string {
  const text = raw.trim();
  if (!text || text.toLowerCase() === "featured") return text;
  const m = text.match(RELATIVE_DATE_RE);
  if (!m) return text;
  const n = parseInt(m[1], 10);
  const unitMs = MS_PER_UNIT[m[2].toLowerCase()];
  if (!unitMs || Number.isNaN(n)) return text;
  return new Date(now - n * unitMs).toISOString();
}
