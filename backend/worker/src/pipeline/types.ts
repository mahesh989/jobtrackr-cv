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
  // Work-setting classification — set by settingClassifier (stage 10c).
  // null category = not a care/health job (unclassified, never filtered).
  setting_category: "hospital_clinical" | "residential_aged_care" | "home_community" | "other" | null;
  setting_confidence: number | null;
  setting_evidence: string | null;
  // Driving distance from the profile's home_address — set by the distance
  // stage (between working-rights filter and save). Both null when the
  // profile has no home_address or the job location can't be geocoded.
  distance_km: number | null;
  distance_method: "driving" | "haversine" | null;
}
