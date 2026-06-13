// Visa information extractor — Stage 10a
//
// Strategy (cheapest-first):
//   1. Scan the FULL description for visa/sponsorship/working rights keywords
//   2. Extract only the containing sentences (~200-800 chars total)
//   3. Apply deterministic regex — handles ~65% of cases for free, instantly
//   4. For the remaining ambiguous cases, send ONLY the extracted sentences
//      to AI for a binary yes/no decision (tiny prompt, very cheap)
//
// Result: clear binary labels instead of a vague 0.0-1.0 float.
// Keeps visa_likelihood as a derived float (1.0 / 0.5 / 0.0) for sort compat.

import type { NormalisedJob } from "../pipeline/types.js";

export interface VisaInfo {
  sponsorship_status: "yes" | "no" | "not_mentioned";
  citizen_pr_only: boolean | null;     // null = not mentioned in JD
  visa_extracted_text: string | null;  // sentences we found, for transparency
  visa_likelihood: number;             // derived: 1.0 | 0.5 | 0.0
}

// ── Sentence extraction ──────────────────────────────────────────────────────

const TRIGGER_WORDS = [
  "visa", "sponsor", "sponsorship",
  "working rights", "work rights", "right to work", "work permit",
  "work authorization", "work authorisation",
  "eligible to work", "authorised to work", "authorized to work",
  "citizen", "citizenship", "permanent resident", "pr holder",
  "temporary visa", "temporary resident",
  "security clearance", "nv1", "nv2", "baseline clearance", "negative vetting",
  "full working rights", "international applicant", "relocation",
  "global mobility",
];

function extractRelevantSentences(text: string, maxChars = 900): string | null {
  if (!text || text.length < 10) return null;

  const lower = text.toLowerCase();

  // Quick bail — does the JD mention any trigger word at all?
  if (!TRIGGER_WORDS.some((w) => lower.includes(w))) return null;

  // Split into sentences on `. ` `! ` `? ` or newlines
  const sentences = text
    .replace(/\r?\n+/g, ". ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);

  const relevant = sentences.filter((s) => {
    const sl = s.toLowerCase();
    return TRIGGER_WORDS.some((w) => sl.includes(w));
  });

  if (relevant.length === 0) return null;

  let joined = relevant.join(" ").trim();
  if (joined.length > maxChars) joined = joined.slice(0, maxChars) + "…";
  return joined;
}

// ── Deterministic pattern matching ──────────────────────────────────────────
// Returns "yes" | "no" | null (null = ambiguous, needs AI)

function matchSponsorship(text: string): "yes" | "no" | null {
  // ── Explicit NO checked FIRST ──
  // Negatives must be evaluated before positives so that phrases like
  // "No sponsorship or relocation available" don't accidentally trigger
  // the relocation YES pattern before we see the leading "No sponsorship".
  //
  // ONLY phrases that explicitly reference the sponsorship process itself.
  // Phrases about current work eligibility ("must have full working rights",
  // "must be eligible to work in Australia") are intentionally excluded —
  // they describe whether you can start NOW, not whether the employer will
  // sponsor a future visa. A 482 holder has full working rights today and
  // can still seek sponsorship for renewal or PR pathway.
  if (/\bno\b.{0,20}\bvisa.{0,10}sponsorship\b/i.test(text)) return "no";
  if (/\bno\b.{0,15}\bsponsorship\b/i.test(text)) return "no";
  if (/\bno\b.{0,20}\brelocation\b/i.test(text)) return "no"; // "no sponsorship or relocation available"
  if (/\bsponsorship\b.{0,30}\b(is |are )?(not|cannot|unavailable|isn.t|will not be)\b/i.test(text)) return "no";
  if (/\bvisa\b.{0,30}\b(not|cannot|won.t|will not)\b.{0,20}\b(provided|sponsored|available|offered|supported)\b/i.test(text)) return "no";
  if (/\bsponsorship is not (available|provided|offered)\b/i.test(text)) return "no";
  if (/\bsponsor.{0,30}not available\b/i.test(text)) return "no";
  if (/\bno\s+(international|overseas)\s+(applicants?|candidates?)\b/i.test(text)) return "no";
  // "authorised to work without sponsorship" = explicit statement that no sponsorship offered
  if (/\bwork authoris.{0,10} without.{0,20}sponsorship\b/i.test(text)) return "no";
  if (/\bwithout.{0,20}(need(ing)?|requiring|the need for).{0,20}sponsorship\b/i.test(text)) return "no";

  // ── Explicit YES ──
  if (/\bvisa sponsorship\b.{0,80}\b(available|provided|offered|supported|can be|will be|is included|included)\b/i.test(text)) return "yes";
  if (/\b(provide|offer|support|include|arrange).{0,30}\bvisa sponsorship\b/i.test(text)) return "yes";
  if (/\b(will|can|do|does|may|are able to)\b.{0,20}\bsponsor\b.{0,30}\b(visa|work|applicant|candidate)\b/i.test(text)) return "yes";
  if (/\bsponsorship\b.{0,30}\b(is |are |will be )?(available|provided|offered|supported|on offer)\b/i.test(text)) return "yes";
  if (/\bopen to international (applicants?|candidates?)\b/i.test(text)) return "yes";
  if (/\binternational (applicants?|candidates?).{0,50}(welcome|encouraged|considered|invited|apply)\b/i.test(text)) return "yes";
  if (/\bwork(ing)? rights?.{0,40}(assist|support|provid|help|facilitat|arrange)/i.test(text)) return "yes";
  if (/\bglobal mobility\b/i.test(text)) return "yes";
  // Relocation YES — but only when "no relocation" hasn't already been excluded above
  if (/\brelocation\b.{0,40}\b(package|assistance|allowance|support|provided|available|offered)\b/i.test(text)) return "yes";
  if (/\bvisa.{0,30}(assistance|support|help|arranged|provided)\b/i.test(text)) return "yes";

  return null; // ambiguous
}

// Returns true (citizens/PR only) | null (not clearly mentioned)
function matchCitizenPROnly(text: string): boolean | null {
  if (/\bmust be an? (australian\s+)?(citizen|national|permanent resident)\b/i.test(text)) return true;
  if (/\baustralian citizens? (and|or|\/|,).{0,10}permanent residents?\b/i.test(text)) return true;
  if (/\bpermanent residents? (and|or|\/|,).{0,10}(australian\s+)?citizens?\b/i.test(text)) return true;
  if (/\bcitizens?(\/| or | and )pr\b/i.test(text)) return true;
  if (/\bpr(\/| or | and )citizens?\b/i.test(text)) return true;
  if (/\b(australian\s+)?(citizens?|permanent residents?)\s+only\b/i.test(text)) return true;
  if (/\bpermanent residen(ce|cy)\b.{0,40}(required|essential|must|mandatory)\b/i.test(text)) return true;
  if (/\b(nv1|nv2|baseline clearance|negative vetting)\b/i.test(text)) return true;
  // Security clearance strongly implies citizenship in AU government context
  if (/\bsecurity clearance\b.{0,40}(required|essential|needed|must|mandatory)\b/i.test(text)) return true;
  // NOTE: "right to work in Australia required" is intentionally NOT here —
  // that phrase means any valid visa holder can apply, not citizens/PR only.
  if (/\b(only|exclusively).{0,20}(australian citizens?|permanent residents?)\b/i.test(text)) return true;

  return null;
}

function deriveVisaLikelihood(
  sponsorship: "yes" | "no" | "not_mentioned",
  citizenPROnly: boolean | null
): number {
  if (sponsorship === "yes") return 1.0;
  if (sponsorship === "no" || citizenPROnly === true) return 0.0;
  return 0.5; // not_mentioned
}

// ── AI fallback for ambiguous cases ─────────────────────────────────────────

const AI_SYSTEM = `You classify sentences from Australian job descriptions for visa/sponsorship status.
Return ONLY valid JSON — no explanation, no markdown.

Schema: {"sponsorship":"yes"|"no"|"not_mentioned","citizen_pr_only":"yes"|"no"|"not_mentioned"}

sponsorship:
- "yes" = employer will sponsor visas / relocation offered / open to international applicants
- "no"  = explicitly states no sponsorship available / cannot offer sponsorship
- "not_mentioned" = not clearly addressed

IMPORTANT: These phrases are about CURRENT work eligibility, NOT sponsorship — classify as "not_mentioned":
- "must have full working rights" — means you must be able to work NOW, says nothing about future sponsorship
- "must be eligible to work in Australia" — same, any valid visa qualifies
- "right to work in Australia required" — same
- "unrestricted work rights" — same

citizen_pr_only:
- "yes" = must specifically be Australian citizen OR permanent resident (excludes other visa holders)
- "no"  = explicitly open to other visa holders
- "not_mentioned" = not clearly addressed`;

interface AIVisaResult {
  sponsorship: "yes" | "no" | "not_mentioned";
  citizen_pr_only: "yes" | "no" | "not_mentioned";
}

async function classifyWithAI(extractedText: string): Promise<AIVisaResult | null> {
  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase();
  const msg = `Sentences from job description:\n${extractedText}`;

  try {
    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 80,
        system: AI_SYSTEM,
        messages: [{ role: "user", content: msg }],
      });
      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      return json ? JSON.parse(json) : null;
    } else {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: AI_SYSTEM },
          { role: "user", content: msg },
        ],
      });
      const text = res.choices[0]?.message?.content ?? "";
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      return json ? JSON.parse(json) : null;
    }
  } catch (err) {
    console.warn("[visaExtractor] AI fallback error:", err);
    return null;
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

const AI_CONCURRENCY = 8;

export async function extractVisaInfo(jobs: NormalisedJob[]): Promise<Map<string, VisaInfo>> {
  const results = new Map<string, VisaInfo>();
  const ambiguous: Array<{ urlHash: string; extracted: string }> = [];

  let deterministicYes = 0;
  let deterministicNo  = 0;
  let deterministicCPR = 0;
  let noSignals        = 0;

  for (const job of jobs) {
    const extracted = extractRelevantSentences(job.description);

    if (!extracted) {
      // No visa keywords anywhere in the JD
      noSignals++;
      results.set(job.url_hash, {
        sponsorship_status: "not_mentioned",
        citizen_pr_only: null,
        visa_extracted_text: null,
        visa_likelihood: 0.5,
      });
      continue;
    }

    const sponsorship  = matchSponsorship(extracted);
    const citizenPR    = matchCitizenPROnly(extracted);

    // If citizen/PR is explicitly detected, sponsorship is implicitly "no"
    const effectiveSponsorship: "yes" | "no" | null =
      citizenPR === true && sponsorship === null ? "no" : sponsorship;

    if (effectiveSponsorship !== null || citizenPR !== null) {
      // Deterministic path — no AI needed
      const finalSp  = effectiveSponsorship ?? "not_mentioned";
      const finalCPR = citizenPR;

      if (finalSp === "yes") deterministicYes++;
      else if (finalSp === "no") deterministicNo++;
      if (finalCPR === true) deterministicCPR++;

      results.set(job.url_hash, {
        sponsorship_status: finalSp as "yes" | "no" | "not_mentioned",
        citizen_pr_only: finalCPR,
        visa_extracted_text: extracted,
        visa_likelihood: deriveVisaLikelihood(finalSp as "yes" | "no" | "not_mentioned", finalCPR),
      });
    } else {
      // Ambiguous — extracted sentences exist but no clear pattern matched
      ambiguous.push({ urlHash: job.url_hash, extracted });
    }
  }

  console.log(
    `[visaExtractor] deterministic: ${deterministicYes} sponsored, ${deterministicNo} no-sponsor, ${deterministicCPR} PR/citizen-only, ${noSignals} no-signals` +
    ` | ambiguous → AI: ${ambiguous.length}`
  );

  // AI batch for ambiguous cases (concurrent, capped)
  if (ambiguous.length > 0) {
    let idx = 0;
    const workers = Array.from(
      { length: Math.min(AI_CONCURRENCY, ambiguous.length) },
      async () => {
        while (idx < ambiguous.length) {
          const item = ambiguous[idx++];
          if (!item) continue;
          const { urlHash, extracted } = item;

          const ai = await classifyWithAI(extracted);

          const sp: "yes" | "no" | "not_mentioned" =
            ai?.sponsorship === "yes" ? "yes"
            : ai?.sponsorship === "no" ? "no"
            : "not_mentioned";

          const cpr: boolean | null =
            ai?.citizen_pr_only === "yes" ? true
            : ai?.citizen_pr_only === "no" ? false
            : null;

          results.set(urlHash, {
            sponsorship_status: cpr === true ? "no" : sp,
            citizen_pr_only: cpr,
            visa_extracted_text: extracted,
            visa_likelihood: deriveVisaLikelihood(cpr === true ? "no" : sp, cpr),
          });
        }
      }
    );
    await Promise.all(workers);
  }

  return results;
}
