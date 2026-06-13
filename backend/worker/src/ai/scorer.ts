// Stage 10 — AI scoring, provider-swappable.
//
// AI_PROVIDER=openai     → gpt-4o-mini  (dev/testing, fast, cheap)
// AI_PROVIDER=anthropic  → claude-haiku-4-5 Batch API (production, 50% discount)
//
// External interface is identical regardless of provider.
// Switch providers by changing AI_PROVIDER env var — no code changes.

import type { NormalisedJob } from "../pipeline/types.js";
import {
  keywordsHash, cacheKey, cacheLookup, cacheWrite,
  type CachedScore,
} from "./cache.js";

export interface ScoringResult {
  scores: Map<string, CachedScore>; // url_hash → score
  inputTokensUsed: number;
  outputTokensUsed: number;
  cacheHits: number;
  batchId: string | null;
  provider: string;
}

// ─── shared helpers ──────────────────────────────────────────────────────────

const DESC_LIMIT = 500;
const MAX_OUTPUT_TOKENS = 256;

const SYSTEM_PROMPT = `You are a job relevance scorer for Australian job seekers.
Given a job listing and the candidate's search keywords, return ONLY valid JSON — no explanation, no markdown.

Required schema:
{
  "visa_likelihood": <float 0.0-1.0>,
  "visa_signals": [<string>, ...]
}

Scoring rules:

visa_likelihood (probability employer will sponsor a work visa)
- 1.0  = explicit "visa sponsorship provided" / "we sponsor visas" / "relocation package available"
- 0.7-0.9 = "open to international applicants", "work rights assistance", "global mobility"
- 0.4-0.6 = large multinational employer, ambiguous signals, or no mention either way
- 0.1-0.3 = small/local business, no signals
- 0.0  = explicit "must have full working rights" / "Australian citizens only" / "no sponsorship"

visa_signals: copy exact short phrases from the description that influenced visa_likelihood.
Return empty array [] if no signals found.`;

function buildUserMessage(job: NormalisedJob, keywords: string[]): string {
  return `Keywords: ${keywords.join(", ")}
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description.slice(0, DESC_LIMIT)}`;
}

function parseScore(raw: string): CachedScore | null {
  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const p = JSON.parse(json);
    return {
      visa_likelihood: Math.min(1, Math.max(0, Number(p.visa_likelihood ?? 0.3))),
      visa_signals: Array.isArray(p.visa_signals) ? p.visa_signals : [],
    };
  } catch {
    return null;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─── OpenAI provider ─────────────────────────────────────────────────────────

async function scoreWithOpenAI(
  jobs: NormalisedJob[],
  keywords: string[]
): Promise<{ scores: Map<string, CachedScore>; inputTokens: number; outputTokens: number }> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let inputTokens = 0;
  let outputTokens = 0;
  const scores = new Map<string, CachedScore>();

  const results = await runWithConcurrency(
    jobs,
    async (job) => {
      const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(job, keywords) },
        ],
      });
      return { job, res };
    },
    10 // 10 concurrent requests
  );

  for (const { job, res } of results) {
    inputTokens  += res.usage?.prompt_tokens ?? 0;
    outputTokens += res.usage?.completion_tokens ?? 0;
    const text  = res.choices[0]?.message?.content ?? "";
    const score = parseScore(text);
    if (score) scores.set(job.url_hash, score);
    else console.warn(`[scorer/openai] parse failed for ${job.url_hash}: ${text}`);
  }

  return { scores, inputTokens, outputTokens };
}

// ─── Anthropic provider ───────────────────────────────────────────────────────

async function scoreWithAnthropic(
  jobs: NormalisedJob[],
  keywords: string[]
): Promise<{ scores: Map<string, CachedScore>; inputTokens: number; outputTokens: number; batchId: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { default: type } = await import("@anthropic-ai/sdk/resources/messages/batches.js").catch(() => ({ default: null }));
  void type; // keep import alive
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const batchRequests = jobs.map((job) => ({
    custom_id: job.url_hash,
    params: {
      model: "claude-haiku-4-5" as const,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [
        {
          type: "text" as const,
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [{ role: "user" as const, content: buildUserMessage(job, keywords) }],
    },
  }));

  console.log(`[scorer/anthropic] submitting batch of ${batchRequests.length}`);
  const batch = await client.messages.batches.create({ requests: batchRequests });

  // Poll up to 5 min
  let current = batch;
  const deadline = Date.now() + 5 * 60_000;
  while (current.processing_status === "in_progress" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    current = await client.messages.batches.retrieve(batch.id);
  }
  if (current.processing_status === "in_progress") {
    throw new Error(`Anthropic batch ${batch.id} did not complete within 5 min`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  const scores = new Map<string, CachedScore>();

  for await (const result of await client.messages.batches.results(batch.id)) {
    if (result.result.type !== "succeeded") continue;
    const msg  = result.result.message;
    inputTokens  += msg.usage.input_tokens;
    outputTokens += msg.usage.output_tokens;
    const text  = msg.content.find((b) => b.type === "text")?.text ?? "";
    const score = parseScore(text);
    if (score) scores.set(result.custom_id, score);
    else console.warn(`[scorer/anthropic] parse failed for ${result.custom_id}`);
  }

  return { scores, inputTokens, outputTokens, batchId: batch.id };
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function scoreJobs(
  jobs: NormalisedJob[],
  keywords: string[],
  profileId: string
): Promise<ScoringResult> {
  if (jobs.length === 0) {
    return { scores: new Map(), inputTokensUsed: 0, outputTokensUsed: 0, cacheHits: 0, batchId: null, provider: "none" };
  }

  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase();

  if (provider === "openai" && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");

  const kwHash = keywordsHash(keywords);

  // Build cache-key map
  const keyMap = new Map<string, string>(); // url_hash → cache_key
  for (const job of jobs) keyMap.set(job.url_hash, cacheKey(job.url_hash, kwHash));

  // Cache lookup
  const cached = await cacheLookup([...keyMap.values()]);
  const scores = new Map<string, CachedScore>();
  const uncached: NormalisedJob[] = [];
  for (const job of jobs) {
    const ck = keyMap.get(job.url_hash)!;
    if (cached.has(ck)) scores.set(job.url_hash, cached.get(ck)!);
    else uncached.push(job);
  }

  const cacheHits = jobs.length - uncached.length;
  console.log(`[scorer] provider=${provider} | cache hits: ${cacheHits} | to score: ${uncached.length}`);

  if (uncached.length === 0) {
    return { scores, inputTokensUsed: 0, outputTokensUsed: 0, cacheHits, batchId: null, provider };
  }

  // Call provider
  let inputTokensUsed = 0;
  let outputTokensUsed = 0;
  let batchId: string | null = null;
  let newScores = new Map<string, CachedScore>();

  if (provider === "openai") {
    const r = await scoreWithOpenAI(uncached, keywords);
    newScores = r.scores;
    inputTokensUsed = r.inputTokens;
    outputTokensUsed = r.outputTokens;
  } else {
    const r = await scoreWithAnthropic(uncached, keywords);
    newScores = r.scores;
    inputTokensUsed = r.inputTokens;
    outputTokensUsed = r.outputTokens;
    batchId = r.batchId;
  }

  // Merge + write cache
  for (const [urlHash, score] of newScores) scores.set(urlHash, score);

  await cacheWrite(
    [...newScores.entries()].map(([urlHash, score]) => ({
      key: keyMap.get(urlHash)!,
      profileId,
      score,
    }))
  );

  console.log(`[scorer] done — scored ${newScores.size}, tokens in/out: ${inputTokensUsed}/${outputTokensUsed}`);
  return { scores, inputTokensUsed, outputTokensUsed, cacheHits, batchId, provider };
}
