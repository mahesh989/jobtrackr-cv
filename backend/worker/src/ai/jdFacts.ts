// JD facts extraction — Stage 10e (deterministic, no AI)
//
// Extracts per-job structured facts from title/description/adapter metadata:
//   • employment types  (full_time / part_time / casual / contract / temporary / internship)
//   • contact emails    (classified: application / enquiry / other)
//   • salary from text  (fallback when the source gave no structured salary)
//   • closing date      ("applications close 25 July")
//   • shift patterns    (healthcare vertical: AM/PM/night/weekend/sleepover/…)
//   • agency detection  ("our client", known AU recruiters)
//
// Everything here is pure regex/lexicon — cheapest-first like visaExtractor,
// but with no AI tier at all: these facts are either stated plainly or absent,
// and a wrong guess is worse than "not stated". Like setting classification,
// results are once-per-job FACTS that flow into global_jobs and are shared by
// every profile; per-profile filtering happens separately at serve time.

// ── Employment types ─────────────────────────────────────────────────────────

export type EmploymentType =
  | "full_time" | "part_time" | "casual" | "contract" | "temporary" | "internship";

export type EmploymentSource = "structured" | "regex";

const ALL_EMPLOYMENT_TYPES: EmploymentType[] = [
  "full_time", "part_time", "casual", "contract", "temporary", "internship",
];

/**
 * Map an adapter's raw work-type string (SEEK workTypes, Adzuna contract_*,
 * Ashby employmentType, …) to canonical tags. Unknown strings map to [].
 */
export function mapStructuredWorkType(raw: string): EmploymentType[] {
  const s = raw.toLowerCase().replace(/[_-]/g, " ").trim();
  const out = new Set<EmploymentType>();
  if (/\bfull ?time\b/.test(s)) out.add("full_time");
  if (/\bpart ?time\b/.test(s)) out.add("part_time");
  if (/\bcasual\b/.test(s) || /\bvacation\b/.test(s)) out.add("casual");
  if (/\bcontract\b/.test(s) || /\bfixed ?term\b/.test(s)) out.add("contract");
  if (/\btemp(orary)?\b/.test(s)) out.add("temporary");
  if (/\bintern(ship)?\b/.test(s)) out.add("internship");
  // "permanent" alone carries no hours information — deliberately unmapped.
  return [...out];
}

// Description/title patterns, AU phrasing included. Order irrelevant — all
// matches accumulate (JDs legitimately offer "Full-time or Part-time").
const EMPLOYMENT_PATTERNS: Array<[RegExp, EmploymentType]> = [
  [/\bfull[- ]?time\b/i, "full_time"],
  [/\bpart[- ]?time\b/i, "part_time"],
  [/\bPPT\b/, "part_time"],                       // permanent part-time
  [/\bpermanent part[- ]?time\b/i, "part_time"],
  [/\bcasual\b/i, "casual"],
  [/\bcasual (pool|bank|basis)\b/i, "casual"],
  [/\bbank staff\b/i, "casual"],
  [/\b(fixed|max)[- ]?term\b/i, "contract"],
  [/\bcontract (role|position|basis)\b/i, "contract"],
  [/\b\d{1,2}[- ](month|week) contract\b/i, "contract"],
  [/\b(parental|maternity) leave (cover|contract)\b/i, "contract"],
  [/\btemporary (role|position|assignment|contract)\b/i, "temporary"],
  [/\bintern(ship)?\b/i, "internship"],
];

// "0.6 FTE" / "FTE 0.8" → part-time; "1.0 FTE" → full-time.
const FTE_RE = /(?:\b(0?\.\d{1,2}|1\.0|1)\s*FTE\b|\bFTE\s*(?:of\s*)?(0?\.\d{1,2}|1\.0|1)\b)/i;

export function extractEmploymentTypes(input: {
  title: string;
  description: string;
  employment_types_raw?: string[];
}): { types: EmploymentType[]; source: EmploymentSource | null } {
  // Tier 1 — structured metadata from the source adapter (authoritative, free)
  const structured = new Set<EmploymentType>();
  for (const raw of input.employment_types_raw ?? []) {
    for (const t of mapStructuredWorkType(raw)) structured.add(t);
  }
  if (structured.size > 0) {
    return { types: ALL_EMPLOYMENT_TYPES.filter((t) => structured.has(t)), source: "structured" };
  }

  // Tier 2 — regex over title + description
  const text = `${input.title}\n${input.description}`;
  const found = new Set<EmploymentType>();
  for (const [re, t] of EMPLOYMENT_PATTERNS) {
    if (re.test(text)) found.add(t);
  }
  const fte = text.match(FTE_RE);
  if (fte) {
    const v = parseFloat(fte[1] ?? fte[2] ?? "");
    if (!Number.isNaN(v)) found.add(v >= 1 ? "full_time" : "part_time");
  }
  if (found.size > 0) {
    return { types: ALL_EMPLOYMENT_TYPES.filter((t) => found.has(t)), source: "regex" };
  }
  return { types: [], source: null };
}

// ── Contact emails ───────────────────────────────────────────────────────────

export type EmailKind = "application" | "enquiry" | "other";

export interface ExtractedEmail {
  email: string;
  kind: EmailKind;
  person: string | null;
  context: string; // the sentence the email appeared in, for transparency
}

const EMAIL_RE = /[A-Z0-9][A-Z0-9._%+'-]*@[A-Z0-9][A-Z0-9.-]*\.[A-Z]{2,}/gi;

// Addresses that are never a human contact.
const EMAIL_NOISE_RE =
  /^(no-?reply|do-?not-?reply|noreply|privacy|unsubscribe|notifications?|support|feedback)@|@(example|test)\.|\.(png|jpe?g|gif|svg|webp)$/i;

const APPLICATION_CONTEXT_RE =
  /\b(apply|applications?|applying|resume|résumé|\bcv\b|cover letter|send (your|us)|submit|forward (your|a))\b/i;
const ENQUIRY_CONTEXT_RE =
  /\b(enquir|inquir|questions?|more information|further information|confidential (discussion|chat|conversation)|contact|reach out|get in touch|speak (to|with)|call|discuss)\b/i;

// "contact Jane Smith on/at …" — best-effort person name near the email.
const PERSON_RE =
  /\b(?:contact|email|call|phone|speak (?:to|with)|reach out to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/;

function sentenceContaining(text: string, needle: string): string {
  const idx = text.indexOf(needle);
  if (idx === -1) return "";
  // Expand to sentence-ish boundaries around the match.
  const start = Math.max(text.lastIndexOf(". ", idx), text.lastIndexOf("\n", idx), 0);
  let end = text.length;
  for (const stop of [". ", "! ", "? ", "\n"]) {
    const e = text.indexOf(stop, idx + needle.length);
    if (e !== -1 && e < end) end = e + 1;
  }
  return text.slice(start === 0 ? 0 : start + 1, end).trim().slice(0, 300);
}

export function extractEmails(description: string): ExtractedEmail[] {
  if (!description || !description.includes("@")) return [];

  const seen = new Set<string>();
  const out: ExtractedEmail[] = [];

  for (const m of description.matchAll(EMAIL_RE)) {
    const email = m[0].replace(/[.,;:]+$/, "").toLowerCase();
    if (seen.has(email) || EMAIL_NOISE_RE.test(email)) continue;
    seen.add(email);

    const context = sentenceContaining(description, m[0]);
    // Application beats enquiry when both signals appear in the sentence —
    // "send your resume to X or call for more information" is an application address.
    const kind: EmailKind = APPLICATION_CONTEXT_RE.test(context)
      ? "application"
      : ENQUIRY_CONTEXT_RE.test(context)
        ? "enquiry"
        : "other";

    const person = context.match(PERSON_RE)?.[1] ?? null;
    out.push({ email, kind, person, context });
  }
  return out;
}

/** The single best address for the auto-apply flow, or null. */
export function bestApplicationEmail(emails: ExtractedEmail[]): string | null {
  return emails.find((e) => e.kind === "application")?.email ?? null;
}

// ── Salary from JD text (fallback when the source gave nothing) ──────────────

export type SalaryPeriod = "hour" | "day" | "week" | "fortnight" | "year";

export interface TextSalary {
  min: number;
  max: number | null;
  period: SalaryPeriod;
}

const PERIOD_RE =
  /\b(?:per|an?|\/)\s*(hour|hr|day|week|fortnight|annum|year)\b|\bp\.?a\.?\b|\bp\/h\b|\bph\b/i;

function normalisePeriod(raw: string): SalaryPeriod {
  const s = raw.toLowerCase();
  if (s.includes("hour") || s === "hr" || s === "p/h" || s === "ph") return "hour";
  if (s.includes("day")) return "day";
  if (s.includes("week")) return "week";
  if (s.includes("fortnight")) return "fortnight";
  return "year"; // annum / year / p.a.
}

// "$34.50 - $42.10 per hour", "$85,000 – $95k + super", "circa $90k", "$45/hr"
const SALARY_RANGE_RE =
  /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)(k)?\s*(?:-|–|—|to)\s*\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)(k)?/i;
const SALARY_SINGLE_RE = /(?:circa|around|up to|from)?\s*\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)(k)?\b/i;

function parseAmount(num: string, k: string | undefined): number {
  const v = parseFloat(num.replace(/,/g, ""));
  return k ? v * 1000 : v;
}

export function extractTextSalary(description: string): TextSalary | null {
  if (!description || !description.includes("$")) return null;

  const range = description.match(SALARY_RANGE_RE);
  const single = range ? null : description.match(SALARY_SINGLE_RE);
  const m = range ?? single;
  if (!m) return null;

  const min = parseAmount(m[1], m[2]);
  const max = range ? parseAmount(range[3], range[4]) : null;

  // Period: look near the match first, then anywhere.
  const tail = description.slice((m.index ?? 0), (m.index ?? 0) + m[0].length + 40);
  const periodMatch = tail.match(PERIOD_RE) ?? description.match(PERIOD_RE);
  // No stated period → infer from magnitude: <200 must be hourly, >10k annual,
  // anything between is too ambiguous to claim.
  let period: SalaryPeriod;
  if (periodMatch) period = normalisePeriod(periodMatch[1] ?? periodMatch[0]);
  else if (min < 200) period = "hour";
  else if (min > 10_000) period = "year";
  else return null;

  // Sanity: hourly rates above $500 or annual below $20k are misparses.
  if (period === "hour" && min > 500) return null;
  if (period === "year" && min < 20_000) return null;
  if (max !== null && max < min) return null;

  return { min, max, period };
}

// ── Closing date ─────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

const CLOSE_CONTEXT_RE =
  /\b(applications? clos\w*|closing date|clos(?:es?|ing) (?:on\s+)?|apply (?:by|before)|submissions? clos\w*)\b[:\s]*([^.\n]{0,40})/i;
const DATE_WORDY_RE = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?\s*(\d{4})?/i;
const DATE_NUMERIC_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/;

/**
 * Returns an ISO date (YYYY-MM-DD) or null. `now` is injectable for tests —
 * used to resolve a missing year to "this year, or next if already past".
 */
export function extractClosingDate(description: string, now: Date): string | null {
  const ctx = description.match(CLOSE_CONTEXT_RE);
  if (!ctx) return null;
  const window = ctx[2] ?? "";

  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;

  const wordy = window.match(DATE_WORDY_RE);
  if (wordy && MONTHS[wordy[2].toLowerCase()]) {
    day = parseInt(wordy[1], 10);
    month = MONTHS[wordy[2].toLowerCase()];
    year = wordy[3] ? parseInt(wordy[3], 10) : null;
  } else {
    const num = window.match(DATE_NUMERIC_RE);
    if (num) {
      day = parseInt(num[1], 10);   // AU convention: day first
      month = parseInt(num[2], 10);
      year = parseInt(num[3], 10);
      if (year < 100) year += 2000;
    }
  }

  if (!day || !month || month > 12 || day > 31) return null;

  if (year === null) {
    year = now.getFullYear();
    const candidate = new Date(Date.UTC(year, month - 1, day));
    // If that date is more than a week in the past, it means next year.
    if (candidate.getTime() < now.getTime() - 7 * 86_400_000) year += 1;
  }
  if (year < now.getFullYear() - 1 || year > now.getFullYear() + 2) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── Shift patterns (healthcare) ──────────────────────────────────────────────

export type ShiftPattern =
  | "morning" | "afternoon" | "night" | "weekend"
  | "sleepover" | "on_call" | "rotating_roster" | "split_shifts";

const SHIFT_PATTERNS: Array<[RegExp, ShiftPattern]> = [
  [/\b(am shifts?|morning shifts?|early shifts?)\b/i, "morning"],
  [/\b(pm shifts?|afternoon shifts?|evening shifts?|late shifts?)\b/i, "afternoon"],
  [/\b(night (?:shift|duty|shifts)|nights?\b.{0,15}shift|\bND\b(?=.{0,30}shift)|overnight shifts?)\b/i, "night"],
  [/\bweekend (?:shifts?|work|availability|penalt)/i, "weekend"],
  [/\bsleep\s?overs?\b/i, "sleepover"],
  [/\bon[- ]call\b/i, "on_call"],
  [/\b(rotating|7[- ]day) roster\b|\brotating shifts?\b/i, "rotating_roster"],
  [/\bsplit shifts?\b/i, "split_shifts"],
];

export function extractShiftPatterns(description: string): ShiftPattern[] {
  if (!description) return [];
  const found = new Set<ShiftPattern>();
  for (const [re, tag] of SHIFT_PATTERNS) {
    if (re.test(description)) found.add(tag);
  }
  return [...found];
}

// ── Agency detection ─────────────────────────────────────────────────────────

// Phrases that only recruiters write.
const AGENCY_TEXT_RE =
  /\b(our client|on behalf of (?:our|a) client|my client|the client is|recruitment (?:agency|consultancy)|recruiting on behalf|this is a (?:temp|contract) role with our client)\b/i;

// Known AU recruiters (healthcare-heavy, matching this product's verticals).
const AGENCY_NAMES_RE =
  /\b(healthcare australia|hca\b|randstad|hays\b|drake medox|sanctuary recruitment|e4 recruitment|redstone recruitment|austra health|talent quarter|zenith search|frontline health|cornerstone medical|jps medical|ihr group|medacs|programmed health)\b/i;

/** true = confidently an agency posting; null = unknown (never claims "false"). */
export function detectAgency(company: string, description: string): boolean | null {
  if (AGENCY_NAMES_RE.test(company)) return true;
  if (AGENCY_TEXT_RE.test(description)) return true;
  return null;
}
