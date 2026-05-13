// Normalised job — output of stage 3, flows through all stages
export interface NormalisedJob {
  url: string;
  url_hash: string;           // sha256(canonicalUrl) — set in stage 5
  content_hash: string;       // sha256(title|company|location) — set in stage 6
  title: string;
  company: string;
  location: string;
  description: string;
  source: string;
  source_tier: number;
  posted_at: string | null;
  expires_at: string | null;
  salary_min?: number;
  salary_max?: number;
  keywords_matched: string[];
  dedup_status: "original" | "duplicate" | "repost" | "possible_duplicate";
  duplicate_of: string | null;  // job UUID if duplicate
  repost_of: string | null;
  // Visa classification — set by visaExtractor (stage 10a)
  sponsorship_status: "yes" | "no" | "not_mentioned";
  citizen_pr_only: boolean | null;    // null = not mentioned
  visa_extracted_text: string | null; // sentences used, for transparency
}
