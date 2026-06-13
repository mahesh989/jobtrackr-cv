/**
 * Worker-side helper for calling cv-backend's /internal/* endpoints.
 *
 * Mirrors web/src/lib/cvBackend.ts: HMAC-SHA256 over (X-Timestamp + raw body),
 * keyed by JOBTRACKR_HMAC_SECRET. cv-backend rejects anything unsigned or
 * stale (>5 min).
 *
 * Phase E-1 — the worker's auto-analyze step uses this to fire
 * /internal/analyze with automation:true. Worker → cv-backend trust is
 * identical to web → cv-backend trust: same shared secret, same envelope.
 */

import { createHmac } from "crypto";

const BASE_URL = process.env.CV_BACKEND_URL;
const SECRET   = process.env.JOBTRACKR_HMAC_SECRET;

export class CvBackendError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message?: string) {
    super(message ?? `cv-backend ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Call a /internal/* endpoint on cv-backend. Returns the parsed JSON
 * body or throws CvBackendError. Path must start with "/internal/".
 */
export async function callCvBackend<T>(
  path:   string,
  body:   unknown,
  opts:   { timeoutMs?: number } = {},
): Promise<T> {
  if (!BASE_URL) throw new Error("CV_BACKEND_URL is not set");
  if (!SECRET)   throw new Error("JOBTRACKR_HMAC_SECRET is not set");
  if (!path.startsWith("/internal/")) throw new Error("path must start with /internal/");

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ts        = Math.floor(Date.now() / 1000);
  const rawBody   = JSON.stringify(body ?? {});
  const sig       = createHmac("sha256", SECRET)
    .update(`${ts}${rawBody}`)
    .digest("hex");

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp":  String(ts),
        "X-Signature":  sig,
      },
      body:    rawBody,
      signal:  AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CvBackendError(
      0,
      err instanceof Error ? err.message : String(err),
      `cv-backend unreachable: ${path}`,
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  if (!res.ok) {
    throw new CvBackendError(res.status, parsed, `cv-backend ${res.status} on ${path}`);
  }
  return parsed as T;
}
