// Work-setting classifier — WEB PORT (deterministic tier only).
//
// ⚠️  KEEP IN SYNC with backend/worker/src/ai/settingClassifier.ts — that file is
// the canonical implementation. This port has NO AI fallback: it's used only for
// manually pasted JDs (PATCH /api/jobs/[id]), which are low-volume and
// user-chosen, so ambiguous → "other" is fine here. The worker owns the AI tier
// and the shared bucket classification.

import type { SettingCategory } from "./settingCategories";

export interface SettingResult {
  setting_category: SettingCategory | null; // null = not a care job
  setting_confidence: number | null;
  setting_evidence: string | null;
}

// Smart-punctuation normalisation — mirror of the canonical worker
// implementation. Real JDs carry curly apostrophes ("clients’ homes"), curly
// quotes and dash variants ("in‑home"); every rule below is written with
// straight ASCII punctuation, so the input is normalised once here instead of
// hardening each regex.
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

const CARE_SIGNALS: RegExp[] = [
  /\bnurs(e|ing)\b/i, /\baged\s+care\b/i, /\bage(d|ing)\b/i, /\belderly\b/i,
  /\bolder\s+(people|persons|australians|adults)\b/i, /\bdisabilit/i, /\bndis\b/i,
  /\bsupport\s+worker\b/i, /\bcare\s+worker\b/i, /\bcarers?\b/i, /\bpersonal\s+care\b/i,
  /\bassistant\s+in\s+nursing\b/i, /\b(ain|pca|rn|en|een)\b/i, /\benrolled\s+nurse\b/i,
  /\bregistered\s+nurse\b/i, /\bhealth\s?care\b/i, /\bclinical\b/i, /\bpatients?\b/i,
  /\bresidents?\b/i, /\bpalliative\b/i, /\bdementia\b/i, /\ballied\s+health\b/i,
  /\bhome\s+care\b/i, /\bcommunity\s+(care|health|support)\b/i,
];

interface Rule { re: RegExp; w: number; tag: string; }

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

const MIN_SCORE = 3;
const MARGIN = 2;

function score(text: string, category: SettingCategory, rules: Rule[]) {
  let s = 0;
  const evidence: string[] = [];
  for (const r of rules) {
    if (r.re.test(text)) {
      s += r.w;
      if (evidence.length < 4 && !evidence.includes(r.tag)) evidence.push(r.tag);
    }
  }
  return { category, score: s, evidence };
}

/**
 * Classify a manually pasted JD. Deterministic only. Returns a null category
 * when the text isn't a care/health job (no badge, never filtered), and "other"
 * when it's a care job we can't confidently pin.
 */
export function classifySettingText(rawText: string): SettingResult {
  const none: SettingResult = { setting_category: null, setting_confidence: null, setting_evidence: null };
  if (!rawText || rawText.length < 10) return none;
  const text = normaliseSmartPunct(rawText);
  if (!CARE_SIGNALS.some((re) => re.test(text))) return none;

  const scored = [
    score(text, "home_community", HOME_RULES),
    score(text, "residential_aged_care", RESIDENTIAL_RULES),
    score(text, "hospital_clinical", HOSPITAL_RULES),
  ].sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  const second = scored[1]!;

  if (top.score >= MIN_SCORE && top.score - second.score >= MARGIN) {
    const confidence = Math.min(0.95, 0.7 + 0.05 * (top.score - second.score));
    return {
      setting_category: top.category,
      setting_confidence: Number(confidence.toFixed(2)),
      setting_evidence: top.evidence.join(", ") || null,
    };
  }

  // Care job, no confident winner → other (fail-open in the filter).
  return {
    setting_category: "other",
    setting_confidence: 0.3,
    setting_evidence: top.evidence.join(", ") || null,
  };
}
