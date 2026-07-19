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
import type { StoryNumber, ToneTarget } from "@/lib/types";
import type { AiProvider } from "@/lib/ai/models";
export type { StoryNumber } from "@/lib/types";

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
  const rawBody   = JSON.stringify(body ?? {});

  // Retry ONLY on connection-level failures (status 0 — the request never
  // reached the backend, e.g. a Fly machine restart during a deploy or a
  // transient network blip). Because the server never received the request,
  // retrying is safe even for POSTs (no duplicate eval runs). We do NOT retry
  // timeouts (the server may be mid-work) or HTTP 4xx/5xx (a real response).
  const maxAttempts  = 3;
  const baseDelayMs  = 1_500;

  let lastConnErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Fresh timestamp + signature each attempt so the HMAC window stays valid.
    const ts  = Math.floor(Date.now() / 1000);
    const sig = crypto
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
      lastConnErr = err;
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      if (!isTimeout && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
        continue; // connection blip — retry with backoff
      }
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

  // Exhausted retries on connection failures.
  throw new CvBackendError(
    0,
    lastConnErr instanceof Error ? lastConnErr.message : String(lastConnErr),
    `cv-backend unreachable after ${maxAttempts} attempts: ${path}`,
  );
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
    // Pure pypdf/python-docx text extraction (no OCR/AI) — 1-3s for a normal
    // 2-3 page CV. 30s is headroom for the worst realistic case: a ~5MB
    // image-heavy PDF on a machine that just cold-booted. Not retried on
    // timeout, so this is a hard ceiling; kept well inside the route's 60s cap.
    { timeoutMs: 30_000 },
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
  ai_provider: AiProvider;
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
    { timeoutMs: 30_000 },         // AI call can take a few seconds
  );
}

export type ExtractCvReferencesPayload = CategoriseCvPayload;

export interface ExtractedReferee {
  name:      string;
  job_title: string;
  company:   string;
  email:     string;
}

export interface ExtractCvReferencesResponse {
  referees: ExtractedReferee[];
}

export function extractCvReferences(
  payload: ExtractCvReferencesPayload,
): Promise<ExtractCvReferencesResponse> {
  return callCvBackend<ExtractCvReferencesResponse>(
    "/internal/extract-cv-references",
    payload,
    { timeoutMs: 45_000 },
  );
}

// ── /internal/structurize-cv ─────────────────────────────────────────────────

export interface StructurizeCvPayload {
  cv_text:     string;
  ai_provider: AiProvider;
  ai_api_key:  string;
  ai_model?:   string | null;
}

interface StructuredCvSkills {
  technical:        string[];
  soft_skills:      string[];
  domain_knowledge: string[];
}

export interface StructuredCvExperience {
  employer:   string;
  role:       string;
  location:   string;
  start_date: string;
  end_date:   string;
  is_current: boolean;
  bullets:    string[];
}

export interface StructuredCvEducation {
  institution:   string;
  qualification: string;
  location:      string;
  start_date:    string;
  end_date:      string;
  completed:     boolean;
  _moved_from_certifications?: boolean;
}

export interface StructuredCvCertification {
  name:        string;
  issuer:      string;
  code:        string;
  issued_date: string;
}

export interface StructuredCvAward {
  name:        string;
  issuer:      string;
  location:    string;
  date:        string;
  description: string;
}

export interface StructuredCvLanguage {
  language:    string;
  proficiency: string;
}

export interface StructuredCvReferee {
  name:      string;
  job_title: string;
  company:   string;
  email:     string;
}

interface StructuredCvGap {
  section:     string;
  entry_index: string;
  field:       string;
  message:     string;
}

export interface CustomCvSection {
  id:     string;
  title:  string;
  fields: Array<{ label: string; value: string }>;
}

export interface StructuredCvProject {
  name:        string;
  url:         string;
  description: string;
}

export interface StructuredCv {
  summary:         string;
  experience:      StructuredCvExperience[];
  education:       StructuredCvEducation[];
  awards:          StructuredCvAward[];
  languages:       StructuredCvLanguage[];
  certifications:  StructuredCvCertification[];
  skills:          StructuredCvSkills;
  references:      StructuredCvReferee[];
  gaps:            StructuredCvGap[];
  projects?:       StructuredCvProject[];
  custom_sections?: CustomCvSection[];
  /** Parser-logic version. Server component on the review page silently
   *  re-runs structurize when the stored value is below this constant. Mirror
   *  of backend/api/app/services/cv/cv_structurizer.STRUCTURED_CV_VERSION. */
  _version?:      number;
}

/**
 * Bump in lockstep with the Python `STRUCTURED_CV_VERSION` constant whenever
 * parser logic changes. The review-page server component silently re-runs
 * structurization for any CV whose stored `_version` is below this.
 */
export const STRUCTURED_CV_VERSION = 5;

export interface StructurizeCvResponse {
  structured_cv:      StructuredCv;
  normalized_cv_text: string;
}

export function structurizeCv(
  payload: StructurizeCvPayload,
): Promise<StructurizeCvResponse> {
  return callCvBackend<StructurizeCvResponse>(
    "/internal/structurize-cv",
    payload,
    { timeoutMs: 30_000 },   // covers summary/experience/education/awards/certs/refs (skills come from categoriseCv)
  );
}

// ── /internal/render-canonical-cv ────────────────────────────────────────────

export interface RenderCanonicalCvPayload {
  structured_cv: StructuredCv;
}

export interface RenderCanonicalCvResponse {
  normalized_cv_text: string;
}

export function renderCanonicalCv(
  payload: RenderCanonicalCvPayload,
): Promise<RenderCanonicalCvResponse> {
  return callCvBackend<RenderCanonicalCvResponse>(
    "/internal/render-canonical-cv",
    payload,
    { timeoutMs: 10_000 },  // pure function, no AI
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
  // Gate thresholds — globally fixed at 60 / 70 since migration 041.
  // cv-backend AnalyzeRequest defaults to those; web + worker omit these
  // fields entirely. Left optional for backward compat with any caller
  // that still sends them.
  min_initial_ats?: number;
  min_final_ats?:   number;
  // Phase C-3 — true ONLY when the user clicked "Force tailoring
  // anyway" on a job that failed the initial ATS gate. Default false:
  // gate is hard, pipeline stops before tailoring on low-match jobs.
  skip_initial_gate?: boolean;
  // Resume — true ONLY when re-triggering an existing run that stopped at
  // the initial-ATS gate. cv-backend reuses the run's already-saved
  // jd_analysis / cv_jd_matching / ats_scoring results and continues from
  // input_recommendations, avoiding the two early AI calls. Implies the
  // initial gate is bypassed.
  resume?: boolean;
  // Phase E-1 — true ONLY when the worker's auto-analyze fires this
  // request. The /api/jobs/[id]/analyze route always sends false (or
  // omits) so manual runs stay distinguishable.
  automation?: boolean;
  // Explicit vertical from the job search profile (e.g. "tech", "nursing",
  // "manual", "general"). When present the orchestrator skips auto-detection
  // and routes directly to the specified vertical pipeline.
  target_vertical?: string | null;
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
  ai_provider: AiProvider;
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

interface ScoredStory {
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

interface RecentEvent {
  date:                       string | null;
  event:                      string;
  source_url:                 string | null;
  relevance_to_applicants:    string;
  stale:                      boolean;
}

interface CompanyFacts {
  description_short:    string;
  industry:             string;
  size:                 "startup" | "small" | "mid" | "large" | "enterprise";
  headquarters:         string;
  recent_events:        RecentEvent[];
  products_or_services: string[];
  mission_statement:    string;
  distinguishing_facts: string[];
}

interface VoiceSignals {
  tone:               "formal_corporate" | "professional_warm" | "casual_startup" | "technical" | "mission_driven";
  sample_text:        string;
  common_vocabulary:  string[];
  avoids:             string[];
}

interface HiringIntel {
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
  /** JD's job location (e.g. "Rouse Hill, Sydney NSW"). When supplied,
   *  cv-backend biases Tavily queries toward the right geography and
   *  flags wrong-country facts during AI distillation. Defends against
   *  same-name org conflations (the "Sanctuary" regression). */
  jd_location?:    string | null;
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

interface RankedFact {
  fact_text:    string;
  score:        number;
  source_field: string;
}

export interface SelectCompanyFactPayload {
  company_id:   string;
  facts:        CompanyFacts;
  jd_text:      string;
  cv_text:      string;
  /** JD's job location. When supplied AND a country can be inferred,
   *  cv-backend drops candidate facts that mention a different country
   *  before ranking. None falls back to legacy geographically-naive ranking. */
  jd_location?: string | null;
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
  tone_target:       ToneTarget;
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

// ── Voice-rewrite email body ──────────────────────────────────────────────────

export interface VoiceRewriteEmailPayload {
  user_id:           string;
  letter_id:         string;
  job_title:         string;
  company:           string;
  hiring_manager?:   string | null;
  user_name?:        string | null;
  /** Verbatim writing sample. Never log this field. */
  voice_sample_text: string;
  /** Boilerplate body to style-transfer. Never log this field. */
  boilerplate_body:  string;
  ai_provider:       "anthropic" | "openai" | "deepseek";
  ai_api_key:        string;
  ai_model?:         string;
}

export interface VoiceRewriteEmailResult {
  body: string;
}

export function voiceRewriteEmail(
  payload: VoiceRewriteEmailPayload,
): Promise<VoiceRewriteEmailResult> {
  return callCvBackend<VoiceRewriteEmailResult>(
    "/internal/voice-rewrite-email",
    payload,
    // Synchronous AI call — single short body. Typical latency 3-8 s.
    { timeoutMs: 30_000 },
  );
}

// ── Eval harness (beta A/B/C/D screen) — removed, dead code ──────────────────
// triggerEvalRun/getEvalRun/AnalyzeEvalPayload/AnalyzeEvalResult/EvalRunRow had
// zero callers anywhere in the repo despite a doc comment claiming "used by the
// beta screen's poll loop" — that screen is gone, these weren't. Deleted.
