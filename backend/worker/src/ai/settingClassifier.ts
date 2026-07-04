// Work-setting classifier — Stage 10c
//
// Classifies each job's WORK SETTING (where the care is physically delivered)
// into one of four categories. This is a shared, once-per-job FACT (like
// sponsorship_status) — computed here, stored on global_jobs / jobs, and reused
// by every profile. The per-profile FILTER (drop by the user's selection) lives
// separately in pipeline/settingFilter.ts and runs at serve time.
//
// Strategy — cheapest first, mirrors visaExtractor.ts:
//   1. Care-vertical gate: if the JD has no nursing/health/care signal at all,
//      return null (skip — not our domain, no badge, never filtered).
//   2. Deterministic scored keyword pass: resolves the confident majority for
//      free. Signals are weighted; the top category must clear a threshold AND
//      beat the runner-up by a margin, else the job is "ambiguous".
//   3. AI fallback (only for ambiguous, only when SETTING_CLASSIFIER_AI=true):
//      one tiny call over the extracted setting sentences. Off by default so we
//      can ship rules-only and measure the ambiguous rate before spending AI.
//
// The 4 categories are the canonical taxonomy (keep in sync with the web port
// frontend/web/src/lib/settingClassifier.ts and shared category labels):
//   hospital_clinical      — hospitals, wards, day surgery, GP/clinics, dialysis…
//   residential_aged_care  — nursing homes / RACF + retirement villages
//   home_community         — care in the client's own home OR travelling between
//   other                  — a care job we can't confidently pin (fail-open)

import type { NormalisedJob } from "../pipeline/types.js";

export type SettingCategory =
  | "hospital_clinical"
  | "residential_aged_care"
  | "home_community"
  | "other";

export interface SettingInfo {
  /** null = not a care/health job → no classification, no badge, never filtered. */
  setting_category: SettingCategory | null;
  setting_confidence: number; // 0.0–1.0
  /** Phrases that drove the decision, for transparency on the job card. */
  setting_evidence: string | null;
  /** How it was decided — useful in logs and for tuning. */
  setting_method: "keyword" | "ai" | "none";
}

// ── Smart-punctuation normalisation ──────────────────────────────────────────
// Real JDs are authored in Word/Google Docs and published with typographic
// punctuation: curly apostrophes ("clients’ homes", U+2019), curly quotes, and
// non-breaking hyphens / en-dashes ("in‑home"). Every rule below is written
// with straight ASCII punctuation, so we normalise the input ONCE here instead
// of hardening each regex — this keeps every current and future rule immune.
// Production bug (2026-07-03): a Mor. Care Group home-care JD containing
// "clients’ homes" with a curly apostrophe scored 0 against the weight-3
// clients'-homes rule and landed in the fail-open 'other' bucket, slipping
// through a residential-only setting filter.
const SMART_PUNCT: Array<[RegExp, string]> = [
  [/[‘’ʼ]/g, "'"], // ‘ ’ ʼ  curly/modifier apostrophes → '
  [/[“”]/g, '"'],       // “ ”    curly double quotes → "
  [/[‐‑‒–—−]/g, "-"], // ‐ ‑ ‒ – — −  dash variants → -
];

function normaliseSmartPunct(text: string): string {
  let out = text;
  for (const [re, to] of SMART_PUNCT) out = out.replace(re, to);
  return out;
}

// ── Care-vertical gate ───────────────────────────────────────────────────────
// If none of these appear, the JD is not in our nursing/health/care domain and
// we skip classification entirely (return null). Short acronyms use strict word
// boundaries to avoid matching inside longer words (e.g. "trained" ⊅ "ain").
const CARE_SIGNALS: RegExp[] = [
  /\bnurs(e|ing)\b/i,
  /\baged\s+care\b/i,
  /\bage(d|ing)\b/i,
  /\belderly\b/i,
  /\bolder\s+(people|persons|australians|adults)\b/i,
  /\bdisabilit/i,
  /\bndis\b/i,
  /\bsupport\s+worker\b/i,
  /\bcare\s+worker\b/i,
  /\bcarers?\b/i,
  /\bpersonal\s+care\b/i,
  /\bassistant\s+in\s+nursing\b/i,
  /\b(ain|pca|rn|en|een)\b/i,
  /\benrolled\s+nurse\b/i,
  /\bregistered\s+nurse\b/i,
  /\bhealth\s?care\b/i,
  /\bclinical\b/i,
  /\bpatients?\b/i,
  /\bresidents?\b/i,
  /\bpalliative\b/i,
  /\bdementia\b/i,
  /\ballied\s+health\b/i,
  /\bhome\s+care\b/i,
  /\bcommunity\s+(care|health|support)\b/i,
];

function hasCareSignal(text: string): boolean {
  return CARE_SIGNALS.some((re) => re.test(text));
}

// ── Scored keyword rules per category ────────────────────────────────────────
// Weight 3 = highly discriminative, 2 = strong, 1 = supporting. Home signals are
// the sharpest discriminator (they almost never appear in facility/hospital ads)
// so they carry the most weight — this is the "reject" bucket users care about.

interface Rule {
  re: RegExp;
  w: number;
  tag: string; // short human label used as evidence
}

const HOME_RULES: Rule[] = [
  { re: /\$?\s?\d[\d.]*\s*(?:\/|per)\s*(?:km|kilometre|kilometer)\b/i, w: 3, tag: "$/km" },
  { re: /\b(?:cents?|paid)\s+per\s+(?:km|kilometre|kilometer)\b/i, w: 3, tag: "per km" },
  { re: /\b(?:km|kilometre|mileage)\s+(?:reimburs|allowance)/i, w: 2, tag: "km allowance" },
  { re: /\btravel(?:ling|ing)?\s+between\s+(?:clients?|services?|homes?|participants?|visits?)\b/i, w: 3, tag: "travel between clients" },
  { re: /\bin\s+(?:their|the\s+client'?s?|clients'?|your\s+client'?s?|people'?s|a\s+client'?s?)\s+(?:own\s+)?homes?\b/i, w: 3, tag: "in their own home" },
  { re: /\bclients'?\s+(?:own\s+)?homes?\b/i, w: 3, tag: "clients' homes" },
  { re: /\bin[-\s]?home\s+care\b/i, w: 2, tag: "in-home care" },
  { re: /\bhome\s+care\s+package/i, w: 2, tag: "home care package" },
  { re: /\b(?:hcp|chsp)\b/i, w: 2, tag: "HCP/CHSP" },
  { re: /\bdomiciliary\b/i, w: 2, tag: "domiciliary" },
  { re: /\bcommunity\s+(?:support|care|nursing|aged\s+care)\b/i, w: 1, tag: "community care" },
  { re: /\bown\s+(?:reliable\s+)?(?:car|vehicle)\b/i, w: 1, tag: "own vehicle" },
  { re: /\breliable\s+vehicle\b/i, w: 1, tag: "reliable vehicle" },
  { re: /\bmobile\s+(?:support|care|nursing)\b/i, w: 2, tag: "mobile care" },
];

const RESIDENTIAL_RULES: Rule[] = [
  { re: /\bresidential\s+aged\s+care\b/i, w: 3, tag: "residential aged care" },
  { re: /\baged\s+care\s+(?:facility|home|residence)\b/i, w: 3, tag: "aged care facility" },
  { re: /\bnursing\s+home\b/i, w: 3, tag: "nursing home" },
  { re: /\bracf\b/i, w: 3, tag: "RACF" },
  { re: /\bcare\s+home\b/i, w: 2, tag: "care home" },
  { re: /\b(?:our|the)\s+residents?\b/i, w: 2, tag: "our residents" },
  { re: /\bresidents'?\s+(?:care|wellbeing|needs|lives|home)\b/i, w: 2, tag: "residents' care" },
  { re: /\bretirement\s+(?:village|living|community)\b/i, w: 3, tag: "retirement village" },
  { re: /\bindependent\s+living\s+unit/i, w: 2, tag: "independent living" },
  { re: /\bilu\b/i, w: 1, tag: "ILU" },
  { re: /\blifestyle\s+village\b/i, w: 2, tag: "lifestyle village" },
  { re: /\bmemory\s+support\s+unit\b/i, w: 2, tag: "memory support unit" },
  { re: /\bdementia\s+(?:unit|wing)\b/i, w: 2, tag: "dementia unit" },
  { re: /\baged\s+care\s+home\b/i, w: 3, tag: "aged care home" },
];

const HOSPITAL_RULES: Rule[] = [
  { re: /\b(?:public|private|base|district|community)\s+hospital\b/i, w: 3, tag: "hospital" },
  { re: /\bhospital\b/i, w: 2, tag: "hospital" },
  { re: /\bemergency\s+department\b/i, w: 3, tag: "emergency department" },
  { re: /\b(?:icu|intensive\s+care\s+unit)\b/i, w: 3, tag: "ICU" },
  { re: /\bintensive\s+care\b/i, w: 2, tag: "intensive care" },
  { re: /\boperating\s+theatre?\b/i, w: 3, tag: "operating theatre" },
  { re: /\bperi[-\s]?operative\b/i, w: 2, tag: "perioperative" },
  { re: /\bday\s+(?:surgery|procedure)\b/i, w: 3, tag: "day surgery" },
  { re: /\b(?:in|out)patient\b/i, w: 1, tag: "in/outpatient" },
  { re: /\b(?:acute|sub[-\s]?acute)\s+(?:care|ward|setting|unit)\b/i, w: 2, tag: "acute care" },
  { re: /\bward\b/i, w: 1, tag: "ward" },
  { re: /\b(?:gp|general)\s+practice\b/i, w: 2, tag: "GP practice" },
  { re: /\bpractice\s+nurse\b/i, w: 2, tag: "practice nurse" },
  { re: /\bmedical\s+centre\b/i, w: 2, tag: "medical centre" },
  { re: /\bcommunity\s+health\s+centre\b/i, w: 2, tag: "community health centre" },
  { re: /\b(?:dialysis|oncology|chemotherapy|endoscopy)\b/i, w: 2, tag: "specialist unit" },
  { re: /\b(?:ivf|fertility)\b/i, w: 2, tag: "fertility clinic" },
  { re: /\burgent\s+care\b/i, w: 2, tag: "urgent care" },
  { re: /\bhospice\b/i, w: 2, tag: "hospice" },
  { re: /\b(?:correctional|justice\s+health|forensic)\b/i, w: 2, tag: "justice health" },
];

interface Scored {
  category: SettingCategory;
  score: number;
  evidence: string[];
}

function scoreRules(text: string, category: SettingCategory, rules: Rule[]): Scored {
  let score = 0;
  const evidence: string[] = [];
  for (const r of rules) {
    if (r.re.test(text)) {
      score += r.w;
      if (evidence.length < 4 && !evidence.includes(r.tag)) evidence.push(r.tag);
    }
  }
  return { category, score, evidence };
}

// A confident classification needs the top category to reach MIN_SCORE and beat
// the runner-up by MARGIN. Otherwise the job is ambiguous (→ AI or "other").
const MIN_SCORE = 3;
const MARGIN = 2;

// ── Deterministic classification for one JD ──────────────────────────────────
// Returns a resolved SettingInfo, or { ambiguous } with the sentences to hand
// to the AI fallback. Returns null when there's no care signal at all.

type DetResult =
  | { kind: "resolved"; info: SettingInfo }
  | { kind: "skip" } // not a care job
  | { kind: "ambiguous"; excerpt: string; evidence: string[] };

export function classifySettingDeterministic(rawText: string): DetResult {
  if (!rawText || rawText.length < 10) return { kind: "skip" };
  const text = normaliseSmartPunct(rawText);
  if (!hasCareSignal(text)) return { kind: "skip" };

  const scores = [
    scoreRules(text, "home_community", HOME_RULES),
    scoreRules(text, "residential_aged_care", RESIDENTIAL_RULES),
    scoreRules(text, "hospital_clinical", HOSPITAL_RULES),
  ].sort((a, b) => b.score - a.score);

  const top = scores[0]!;
  const second = scores[1]!;

  if (top.score >= MIN_SCORE && top.score - second.score >= MARGIN) {
    // Confidence scales with how decisively the top category won.
    const confidence = Math.min(0.95, 0.7 + 0.05 * (top.score - second.score));
    return {
      kind: "resolved",
      info: {
        setting_category: top.category,
        setting_confidence: Number(confidence.toFixed(2)),
        setting_evidence: top.evidence.join(", ") || null,
        setting_method: "keyword",
      },
    };
  }

  // Care job, but no confident winner → ambiguous. Extract the sentences that
  // mention any setting/care signal so the AI (if enabled) sees only what matters.
  return { kind: "ambiguous", excerpt: extractSettingSentences(text), evidence: top.evidence };
}

// Pull sentences containing any care/setting keyword, capped, for the AI prompt.
function extractSettingSentences(text: string, maxChars = 1400): string {
  const sentences = text
    .replace(/\r?\n+/g, ". ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);

  const triggers = [...CARE_SIGNALS, ...HOME_RULES.map((r) => r.re), ...RESIDENTIAL_RULES.map((r) => r.re), ...HOSPITAL_RULES.map((r) => r.re)];
  const relevant = sentences.filter((s) => triggers.some((re) => re.test(s)));
  let joined = (relevant.length > 0 ? relevant.join(" ") : text).trim();
  if (joined.length > maxChars) joined = joined.slice(0, maxChars) + "…";
  return joined;
}

// ── AI fallback ──────────────────────────────────────────────────────────────

const AI_SYSTEM = `You classify the WORK SETTING of an Australian nursing/aged-care/health job — where the care is physically delivered. Return ONLY valid JSON, no markdown.

Schema: {"setting":"hospital_clinical"|"residential_aged_care"|"home_community"|"other","confidence":<float 0.0-1.0>}

Definitions:
- "hospital_clinical" = the patient comes to a fixed clinical site or is admitted to a bed: public/private hospital, ward, ED, ICU, theatre, day surgery, GP practice, medical centre, community health CENTRE, dialysis/oncology/IVF clinic, hospice, correctional health.
- "residential_aged_care" = older people LIVE where the care is given: nursing home, residential aged care facility (RACF), retirement village, independent living. Language like "our residents".
- "home_community" = the worker travels to the client: care in the client's OWN home, in-home/domiciliary care, Home Care Package (HCP/CHSP), travel between clients, paid per km, own vehicle required, mobile/community support.
- "other" = a care job whose setting genuinely can't be determined (e.g. an agency pool spanning multiple settings, or a description that never states where the work happens).

Decisive rule: if care happens in the CLIENT'S own home or the worker travels between homes → home_community, even if the role is clinical. If unsure between two, pick the dominant setting; only use "other" when truly indeterminate.`;

interface AISettingResult {
  setting: SettingCategory;
  confidence: number;
}

async function classifyWithAI(excerpt: string): Promise<AISettingResult | null> {
  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase();
  const msg = `Job description:\n${excerpt}`;
  try {
    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 60,
        system: AI_SYSTEM,
        messages: [{ role: "user", content: msg }],
      });
      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      return json ? (JSON.parse(json) as AISettingResult) : null;
    }
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 60,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_SYSTEM },
        { role: "user", content: msg },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? (JSON.parse(json) as AISettingResult) : null;
  } catch (err) {
    console.warn("[settingClassifier] AI fallback error:", err);
    return null;
  }
}

const VALID_CATEGORIES: SettingCategory[] = [
  "hospital_clinical",
  "residential_aged_care",
  "home_community",
  "other",
];

// ── Main export ──────────────────────────────────────────────────────────────

const AI_CONCURRENCY = 8;

function aiFallbackEnabled(): boolean {
  return process.env.SETTING_CLASSIFIER_AI === "true";
}

/**
 * Classify the work setting of each job. Returns a map url_hash → SettingInfo.
 * Non-care jobs are simply absent from the map (caller leaves them null).
 * Deterministic for the confident majority; AI only for ambiguous cases and
 * only when SETTING_CLASSIFIER_AI=true (else ambiguous → "other", fail-open).
 */
export async function classifySettings(jobs: NormalisedJob[]): Promise<Map<string, SettingInfo>> {
  const results = new Map<string, SettingInfo>();
  const ambiguous: Array<{ urlHash: string; excerpt: string; evidence: string[] }> = [];
  const counts: Record<string, number> = {};

  for (const job of jobs) {
    const det = classifySettingDeterministic(job.description ?? "");
    if (det.kind === "skip") continue; // not a care job — leave unclassified
    if (det.kind === "resolved") {
      results.set(job.url_hash, det.info);
      counts[det.info.setting_category ?? "other"] = (counts[det.info.setting_category ?? "other"] ?? 0) + 1;
      continue;
    }
    ambiguous.push({ urlHash: job.url_hash, excerpt: det.excerpt, evidence: det.evidence });
  }

  const useAI = aiFallbackEnabled() && ambiguous.length > 0;
  console.log(
    `[settingClassifier] keyword-resolved: ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ") || "0"}` +
    ` | ambiguous: ${ambiguous.length}${useAI ? " → AI" : " → other (AI off)"}`,
  );

  if (!useAI) {
    // Rules-only mode (or nothing ambiguous): ambiguous care jobs → "other".
    for (const a of ambiguous) {
      results.set(a.urlHash, {
        setting_category: "other",
        setting_confidence: 0.3,
        setting_evidence: a.evidence.join(", ") || null,
        setting_method: "keyword",
      });
    }
    return results;
  }

  let idx = 0;
  const workers = Array.from({ length: Math.min(AI_CONCURRENCY, ambiguous.length) }, async () => {
    while (idx < ambiguous.length) {
      const item = ambiguous[idx++];
      if (!item) continue;
      const ai = await classifyWithAI(item.excerpt);
      const category: SettingCategory =
        ai && VALID_CATEGORIES.includes(ai.setting) ? ai.setting : "other";
      const confidence =
        ai && typeof ai.confidence === "number" ? Math.max(0, Math.min(1, ai.confidence)) : 0.3;
      results.set(item.urlHash, {
        setting_category: category,
        setting_confidence: Number(confidence.toFixed(2)),
        setting_evidence: item.evidence.join(", ") || null,
        setting_method: "ai",
      });
    }
  });
  await Promise.all(workers);

  return results;
}
