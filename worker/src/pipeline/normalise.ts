// Stage 3 — Normalise raw jobs into a consistent shape
import type { RawJob } from "../sources/types.js";
import type { NormalisedJob } from "./types.js";

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&#x27;": "'", "&#x2F;": "/", "&nbsp;": " ",
};

function decodeHtml(str: string): string {
  return str.replace(/&[^;]+;/g, (m) => HTML_ENTITIES[m] ?? m);
}

function normaliseWhitespace(str: string): string {
  return decodeHtml(str).replace(/\s+/g, " ").trim();
}

// Remove common job-board suffixes that pollute titles
const TITLE_NOISE = /\s*[-|–—]\s*(apply now|job opening|new opening|urgent|multiple openings|full time|part time)[\s!.]*$/i;

function normaliseTitle(raw: string): string {
  return normaliseWhitespace(raw).replace(TITLE_NOISE, "");
}

// Simplify AU location strings: "Sydney, New South Wales, AU" → "Sydney, NSW"
const STATE_MAP: Record<string, string> = {
  "new south wales": "NSW", "victoria": "VIC", "queensland": "QLD",
  "western australia": "WA", "south australia": "SA", "tasmania": "TAS",
  "northern territory": "NT", "australian capital territory": "ACT",
};

function normaliseLocation(raw: string): string {
  if (!raw) return "";
  let loc = normaliseWhitespace(raw);
  for (const [full, abbr] of Object.entries(STATE_MAP)) {
    loc = loc.replace(new RegExp(full, "gi"), abbr);
  }
  // Remove country suffix ", AU" or ", Australia"
  loc = loc.replace(/,?\s*(australia|au)\s*$/i, "").trim();
  return loc;
}

function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Drop tracking params
    ["utm_source", "utm_medium", "utm_campaign", "ref", "src"].forEach(
      (p) => u.searchParams.delete(p)
    );
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/$/, "");
  }
}

export function normalise(job: RawJob): NormalisedJob {
  return {
    url: canonicalUrl(job.url),
    url_hash: "",          // set in dedup stage
    content_hash: "",      // set in dedup stage
    title: normaliseTitle(job.title),
    company: normaliseWhitespace(job.company),
    location: normaliseLocation(job.location),
    description: normaliseWhitespace(job.description),
    source: job.source,
    source_tier: job.source_tier,
    posted_at: job.posted_at,
    expires_at: job.expires_at,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    keywords_matched: [],  // set in keyword filter
    dedup_status: "original",
    duplicate_of: null,
    repost_of: null,
    // Visa fields — set by visaExtractor (stage 10a)
    sponsorship_status: "not_mentioned",
    citizen_pr_only: null,
    visa_extracted_text: null,
  };
}
