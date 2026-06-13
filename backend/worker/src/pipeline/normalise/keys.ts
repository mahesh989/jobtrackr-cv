// Normalisation keys for cross-source dedup.
//
// L2-strong:  title + company-prefix + city — drop loser
// L2-weak:    title + company-prefix match but city differs — mark "possible_duplicate"
//
// Designed to collapse the kinds of variation we see across SEEK / Adzuna / Jora:
//   "ING" vs "ING Bank Limited" vs "Tal Services Limited" vs "TAL Australia"
//   "Sydney NSW" vs "Sydney, Sydney Region" vs "The Rocks, Sydney" vs "North Sydney"

const ENTITY_SUFFIXES = new Set([
  "limited", "ltd", "pty", "pvt", "inc", "incorporated", "corp", "corporation",
  "group", "holdings", "co", "company",
]);

const LOCALE_SUFFIXES = new Set([
  "australia", "au", "aus", "nz", "newzealand",
]);

const RECRUITER_NOISE = new Set([
  "recruitment", "consulting", "services", "placements", "search",
  "agency", "staffing", "talent", "resources",
]);

const AU_METROS = [
  "sydney", "melbourne", "brisbane", "perth", "adelaide",
  "canberra", "hobart", "darwin", "gold coast", "newcastle",
  "wollongong", "geelong",
];

const AU_STATES = new Set(["nsw", "vic", "qld", "wa", "sa", "act", "tas", "nt"]);

function stripPunct(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Reduce a company name to its semantic core.
 *   "ING Bank Limited"        → "ing bank"
 *   "ING"                     → "ing"
 *   "Tal Services Limited"    → "tal"
 *   "TAL Australia"           → "tal"
 *   "FourQuarters Recruitment" → "fourquarters"
 */
export function normaliseCompany(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = stripPunct(raw.toLowerCase());
  const tokens = cleaned.split(" ").filter((t) =>
    t && !ENTITY_SUFFIXES.has(t) && !LOCALE_SUFFIXES.has(t) && !RECRUITER_NOISE.has(t)
  );
  return tokens.join(" ");
}

/**
 * Two normalised companies "match" if one is a prefix of the other.
 *   "ing" ↔ "ing bank"     → match
 *   "tal" ↔ "tal"          → match
 *   "ing" ↔ "kfc"          → no match
 * Empty strings never match anything (treat as unknown).
 */
export function companiesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + " ") || b.startsWith(a + " ");
}

/**
 * Extract the primary AU metro (or state code) from a location string.
 *   "North Sydney, North Sydney Area" → "sydney"
 *   "The Rocks, Sydney"               → "sydney"
 *   "Sydney NSW"                      → "sydney"
 *   "Frenchs Forest NSW"              → "nsw"
 *   "All Australia"                   → ""
 */
export function normaliseCity(raw: string | null | undefined): string {
  if (!raw) return "";
  const lower = stripPunct(raw.toLowerCase());
  for (const metro of AU_METROS) {
    if (lower.includes(metro)) return metro;
  }
  // Fallback: first state code present
  for (const token of lower.split(" ")) {
    if (AU_STATES.has(token)) return token;
  }
  return "";
}

/**
 * Lowercase + punct-strip + collapse whitespace. Doesn't strip seniority
 * or specialisation — "Senior Data Analyst" stays distinct from "Data Analyst",
 * and "Data Analyst - HR" stays distinct from "Data Analyst - Finance".
 */
export function normaliseTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  return stripPunct(raw.toLowerCase());
}

/**
 * Composite key used to bucket candidates for cross-source dedup.
 * Same key = candidate duplicate group; need pairwise companyMatch check
 * within the group to confirm.
 */
export function bucketKey(title: string, city: string): string {
  return `${normaliseTitle(title)}|${normaliseCity(city)}`;
}

/**
 * Short, stable company key used only for cross-CITY (weak) bucket grouping.
 * Falls back to first token of the normalised name.
 *   "ING Bank Limited" → "ing"
 *   "ING"              → "ing"
 *   "Tal Services"     → "tal"
 * Collisions on first token are rare and tolerable for weak-tier flagging.
 */
export function companyShortcode(raw: string | null | undefined): string {
  const norm = normaliseCompany(raw);
  return norm.split(" ")[0] ?? "";
}
