/**
 * Shared client for GET /api/applications/[letter_id]/email-draft.
 *
 * Two surfaces can want the same letter's draft at once — the board panel's
 * Cover letter tab fires this the moment a job's letter data loads, and the
 * Apply popup fires its own copy whenever it doesn't already have a cached
 * body. Without de-duplication, opening a job and clicking Apply before the
 * tab's own draft had landed fired the AI voice-rewrite call TWICE for the
 * same letter — doubling both cost and the user's actual wait.
 *
 * Keyed by letter_id: concurrent callers for the SAME letter share one
 * in-flight request and promise; a call for a different letter, or the same
 * letter again after this one has settled, fires its own (harmless — by
 * then the body is cached server-side, so a re-fetch is cheap regardless).
 */
const inFlight = new Map<string, Promise<EmailDraftResponse>>();

export interface EmailDraftResponse {
  subject: string;
  body:    string;
  [key: string]: unknown;
}

export function fetchEmailDraft(letterId: string): Promise<EmailDraftResponse> {
  const existing = inFlight.get(letterId);
  if (existing) return existing;

  const promise = fetch(`/api/applications/${letterId}/email-draft`)
    .then(async (res) => {
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Failed (${res.status})`);
      }
      return res.json() as Promise<EmailDraftResponse>;
    })
    .finally(() => {
      inFlight.delete(letterId);
    });

  inFlight.set(letterId, promise);
  return promise;
}
