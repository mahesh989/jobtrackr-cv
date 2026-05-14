/**
 * Server-side helper for calling the private cv-backend service.
 *
 * Every call is signed with HMAC-SHA256 over (X-Timestamp + raw body),
 * keyed by the shared JOBTRACKR_HMAC_SECRET. cv-backend rejects anything
 * unsigned or stale (>5 min).
 *
 * Only Next.js API routes (server-only) call this — never the browser.
 */
import crypto from "node:crypto";

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
 * Call a /internal/* endpoint on cv-backend. Returns the parsed JSON body or
 * throws CvBackendError. Path must start with "/internal/...".
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
  const sig       = crypto
    .createHmac("sha256", SECRET)
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
      cache:   "no-store",
    });
  } catch (err) {
    throw new CvBackendError(
      0,
      err instanceof Error ? err.message : String(err),
      `cv-backend unreachable: ${path}`,
    );
  }

  // Read body once — try JSON, fall back to text for non-JSON errors.
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  if (!res.ok) {
    throw new CvBackendError(res.status, parsed, `cv-backend ${res.status} on ${path}`);
  }
  return parsed as T;
}

// ── Typed wrappers ───────────────────────────────────────────────────────────

export interface ExtractCvTextResponse {
  cv_text:    string;
  word_count: number;
}

export function extractCvText(storagePath: string): Promise<ExtractCvTextResponse> {
  return callCvBackend<ExtractCvTextResponse>(
    "/internal/extract-cv-text",
    { storage_path: storagePath },
    { timeoutMs: 60_000 },         // pypdf on large PDFs can take a few seconds
  );
}

export interface ScrapeJdResponse {
  jd_text:    string;
  job_title:  string | null;
  source_url: string;
}

export function scrapeJd(url: string): Promise<ScrapeJdResponse> {
  return callCvBackend<ScrapeJdResponse>(
    "/internal/scrape-jd",
    { url },
    { timeoutMs: 20_000 },
  );
}

export interface CategoriseCvPayload {
  cv_text:     string;
  ai_provider: "anthropic" | "openai" | "deepseek";
  ai_api_key:  string;
  ai_model?:   string | null;
}

export interface CategoriseCvResponse {
  technical:        string[];
  soft_skills:      string[];
  domain_knowledge: string[];
}

export function categoriseCv(payload: CategoriseCvPayload): Promise<CategoriseCvResponse> {
  return callCvBackend<CategoriseCvResponse>(
    "/internal/categorise-cv",
    payload,
    { timeoutMs: 45_000 },         // AI call can take a few seconds
  );
}

export interface AnalyzePayload {
  run_id:        string;
  user_id:       string;
  cv_version_id: string;
  jd_text:       string;
  jd_source_url?: string | null;
  jd_meta?:      Record<string, unknown> | null;
  cv_text:       string;
  ai_provider:   "anthropic" | "openai" | "deepseek";
  ai_api_key:    string;
  ai_model?:     string | null;
}

export function startAnalysis(payload: AnalyzePayload): Promise<{ run_id: string; status: string }> {
  return callCvBackend("/internal/analyze", payload);
}
