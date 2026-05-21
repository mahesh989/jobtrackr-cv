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
  contact_details?: Record<string, unknown> | null;
  // Phase C-2 gate thresholds — read from the profile by the analyze
  // route. cv-backend defaults to 55 / 75 if omitted.
  min_initial_ats?: number;
  min_final_ats?:   number;
  // Phase C-3 — true ONLY when the user clicked "Force tailoring
  // anyway" on a job that failed the initial ATS gate. Default false:
  // gate is hard, pipeline stops before tailoring on low-match jobs.
  skip_initial_gate?: boolean;
}

export function startAnalysis(payload: AnalyzePayload): Promise<{ run_id: string; status: string }> {
  return callCvBackend("/internal/analyze", payload);
}

export interface VoiceFingerprintPayload {
  voice_sample_text: string;
  ai_provider:       "anthropic" | "openai" | "deepseek";
  ai_api_key:        string;
  ai_model?:         string | null;
}

export interface VoiceFingerprintResult {
  fingerprint:        Record<string, unknown>;
  trust_score:        number;
  trust_components: {
    ai_pattern_score:             number;
    sentence_variance_score:      number;
    length_appropriateness_score: number;
  };
  word_count:         number;
  matched_ai_phrases: string[];
}

export function extractVoiceFingerprint(
  payload: VoiceFingerprintPayload,
): Promise<VoiceFingerprintResult> {
  return callCvBackend<VoiceFingerprintResult>(
    "/internal/extract-voice-fingerprint",
    payload,
    { timeoutMs: 60_000 },
  );
}

export interface StoryNumber {
  metric: string;
  value:  string;
}

/** A single validated story returned by cv-backend. */
export interface Story {
  title:                string;
  domain:               string;
  year:                 number | null;
  one_line:             string;
  detailed:             string;
  numbers:              StoryNumber[];
  tags:                 string[];
  /** ISO 8601 string — FastAPI serialises Python datetime to this format. */
  extraction_timestamp: string;
}

export interface ExtractStoriesPayload {
  user_id:     string;
  cv_text:     string;
  ai_provider: "anthropic" | "openai" | "deepseek";
  ai_api_key:  string;
  ai_model?:   string | null;
}

export interface ExtractStoriesResult {
  stories:    Story[];
  /** Non-null only when stories is empty — explains why no achievements were found. */
  diagnostic: string | null;
}

export function extractStories(
  payload: ExtractStoriesPayload,
): Promise<ExtractStoriesResult> {
  return callCvBackend<ExtractStoriesResult>(
    "/internal/extract-stories",
    payload,
    { timeoutMs: 90_000 },   // AI call on dense senior CVs; allow generous headroom
  );
}

// ── Story matching (Phase 10.2.b) ────────────────────────────────────────────

/** Story shape sent to /internal/match-stories — DB rows with id populated. */
export interface MatchStoriesStory {
  id:       string;
  title:    string;
  domain:   string;
  year:     number | null;
  one_line: string;
  tags:     string[];
  detailed: string;
  numbers:  StoryNumber[];
  /** Must be present — same shape as Story.extraction_timestamp */
  extraction_timestamp: string;
}

export interface MatchStoriesPayload {
  jd_text: string;
  stories: MatchStoriesStory[];
}

export interface ScoredStory {
  story_id: string;
  score:    number;
}

export interface MatchStoriesResult {
  scored: ScoredStory[];
}

export function matchStories(
  payload: MatchStoriesPayload,
): Promise<MatchStoriesResult> {
  return callCvBackend<MatchStoriesResult>(
    "/internal/match-stories",
    payload,
    { timeoutMs: 10_000 },  // deterministic, no AI — 10s is generous
  );
}

// ── Company research (Phase 10.3) ─────────────────────────────────────────────

export interface RecentEvent {
  date:                       string | null;
  event:                      string;
  source_url:                 string | null;
  relevance_to_applicants:    string;
  stale:                      boolean;
}

export interface CompanyFacts {
  description_short:    string;
  industry:             string;
  size:                 "startup" | "small" | "mid" | "large" | "enterprise";
  headquarters:         string;
  recent_events:        RecentEvent[];
  products_or_services: string[];
  mission_statement:    string;
  distinguishing_facts: string[];
}

export interface VoiceSignals {
  tone:               "formal_corporate" | "professional_warm" | "casual_startup" | "technical" | "mission_driven";
  sample_text:        string;
  common_vocabulary:  string[];
  avoids:             string[];
}

export interface HiringIntel {
  hiring_manager_likely: string | null;
  team_blog_posts:       string[];
  recent_hires_titles:   string[];
}

export interface CompanyResearch {
  company_id:             string;
  name:                   string;
  domain:                 string | null;
  last_researched_at:     string;  // ISO 8601
  research_ttl_days:      number;
  facts:                  CompanyFacts;
  voice_signals:          VoiceSignals;
  hiring_intel:           HiringIntel;
  research_quality_score: number;
  search_skipped:         boolean;
}

export interface ResearchCompanyPayload {
  company_name:    string;
  company_domain?: string | null;
  ai_provider:     "anthropic" | "openai" | "deepseek";
  ai_api_key:      string;
  ai_model?:       string | null;
}

export interface ResearchCompanyResult {
  company_id:   string;
  status:       "completed" | "cached" | "running";
  research:     CompanyResearch | null;
  search_skipped: boolean;
}

export function researchCompany(
  payload: ResearchCompanyPayload,
): Promise<ResearchCompanyResult> {
  return callCvBackend<ResearchCompanyResult>(
    "/internal/research-company",
    payload,
    { timeoutMs: 120_000 },  // Tavily + scrape + AI distill — allow up to 2 min
  );
}

export interface RankedFact {
  fact_text:    string;
  score:        number;
  source_field: string;
}

export interface SelectCompanyFactPayload {
  company_id: string;
  facts:      CompanyFacts;
  jd_text:    string;
  cv_text:    string;
}

export interface SelectCompanyFactResult {
  ranked_facts: RankedFact[];
}

export function selectCompanyFact(
  payload: SelectCompanyFactPayload,
): Promise<SelectCompanyFactResult> {
  return callCvBackend<SelectCompanyFactResult>(
    "/internal/select-company-fact",
    payload,
    { timeoutMs: 10_000 },  // deterministic, no AI
  );
}

// ── Phase 11: Opening paragraph variants ─────────────────────────────────────

export interface OpeningVariant {
  id:            string;
  text:          string;
  pattern_label: string;
}

export interface GenerateOpeningVariantsPayload {
  user_id:           string;
  job_id:            string;
  jd_text:           string;
  role:              string;
  company_name:      string;
  cv_text:           string;
  /** Verbatim writing sample. Never log this field. */
  voice_sample_text: string;
  fingerprint:       Record<string, unknown>;
  story:             Record<string, unknown>;
  company_hook_text: string;
  ai_provider:       "anthropic" | "openai" | "deepseek";
  ai_api_key:        string;
  ai_model?:         string;
}

export interface GenerateOpeningVariantsResult {
  variants: OpeningVariant[];
}

export function generateOpeningVariants(
  payload: GenerateOpeningVariantsPayload,
): Promise<GenerateOpeningVariantsResult> {
  return callCvBackend<GenerateOpeningVariantsResult>(
    "/internal/generate-opening-variants",
    payload,
    // Synchronous AI call — 4 variants × ~60 words. Allow generous headroom
    // for cold starts; typical latency is 5-15 s.
    { timeoutMs: 60_000 },
  );
}

// ── Cover letter generation ───────────────────────────────────────────────────

export interface GenerateCoverLetterPayload {
  /** Pre-created UUID from the cover_letters row. */
  letter_id:         string;
  user_id:           string;
  job_id:            string;
  jd_text:           string;
  role:              string;
  company_name:      string;
  cv_text:           string;
  /** Verbatim writing sample. Never log this field. */
  voice_sample_text: string;
  fingerprint:       Record<string, unknown>;
  story:             Record<string, unknown>;
  company_hook_text: string;
  tone_target:       "professional" | "warm" | "direct";
  word_count_target: number;
  ai_provider:       "anthropic" | "openai" | "deepseek";
  ai_api_key:        string;
  ai_model?:         string;
  /**
   * Phase 11: if set, P1 is already chosen. cv-backend writes P2-4 only and
   * prepends this text as the first paragraph of the stored letter.
   */
  chosen_opening?:   string;
}

export interface GenerateCoverLetterResult {
  letter_id: string;
  status:    "accepted";
}

export function generateCoverLetter(
  payload: GenerateCoverLetterPayload,
): Promise<GenerateCoverLetterResult> {
  return callCvBackend<GenerateCoverLetterResult>(
    "/internal/generate-cover-letter",
    payload,
    // cv-backend returns 202 immediately (BackgroundTask) — 30s is generous
    { timeoutMs: 30_000 },
  );
}
