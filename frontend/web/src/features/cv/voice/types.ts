export interface TrustComponents {
  ai_pattern_score:             number;
  sentence_variance_score:      number;
  length_appropriateness_score: number;
}

export interface SubmitResult {
  trust_score:        number;
  trust_components:   TrustComponents;
  word_count:         number;
  matched_ai_phrases: string[];
  fingerprint:        Record<string, unknown>;
}

export interface VoiceProfile {
  id:                       string;
  fingerprint:              Record<string, unknown>;
  voice_sample_raw:         string | null;
  voice_sample_trust_score: number;
  voice_sample_source:      string;
  created_at:               string;
  updated_at:               string;
}

export type SourceTag = "in_app_capture" | "pasted_cover_letter";

export const WORD_MIN = 150;
export const WORD_MAX = 600;

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function formalityLabel(score: number): string {
  if (score >= 0.7) return "Formal";
  if (score >= 0.4) return "Professional";
  return "Casual";
}

export function sourceLabel(s: string): string {
  if (s === "pasted_cover_letter") return "From a pasted cover letter";
  return "Typed sample";
}
