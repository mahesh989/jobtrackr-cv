/**
 * Idempotent-claim wrapper for the Stripe webhook handler (BUG #36).
 *
 * The dedupe row must be released on handler failure, not left in place —
 * otherwise a transient error (Stripe 5xx, a DB blip) permanently swallows
 * every retry as a duplicate without the handler ever running again, and
 * the event is gone for good once Stripe stops retrying. Extracted so the
 * claim/release ordering can be unit-tested without mocking Supabase.
 */

export interface IdempotencyStore {
  /** Insert the dedupe row. Resolves `duplicate: true` on a unique-violation. */
  claim(eventId: string, type: string): Promise<{ duplicate: boolean }>;
  /** Remove the dedupe row so a retry is treated as fresh. */
  release(eventId: string): Promise<void>;
}

export type IdempotentResult<T> =
  | { status: "duplicate" }
  | { status: "handled"; result: T }
  | { status: "failed"; error: unknown };

export async function runIdempotent<T>(
  store: IdempotencyStore,
  eventId: string,
  type: string,
  handler: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  const claim = await store.claim(eventId, type);
  if (claim.duplicate) return { status: "duplicate" };

  try {
    const result = await handler();
    return { status: "handled", result };
  } catch (error) {
    // Release BEFORE returning — a Stripe retry must see this event as
    // claimable again, not permanently swallowed as a duplicate.
    await store.release(eventId);
    return { status: "failed", error };
  }
}
