// Shared RSS/Atom feed parser + SourceAdapter factory.
// Used by all gov RSS adapters — no external XML dependency.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";

const USER_AGENT = "JobTrackr/1.0 (+https://jobtrackr.app)";

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string {
  // CDATA variant first, then plain text
  const cdata = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i"
  );
  const plain = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = xml.match(cdata) ?? xml.match(plain);
  return m ? m[1].trim() : "";
}

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  company: string;
  location: string;
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, "title");
    // <link> in RSS 2.0 is text between tags, but can appear after CDATA weirdly
    const link =
      extractTag(block, "link") ||
      extractTag(block, "guid") ||
      extractTag(block, "enclosure");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      description: extractTag(block, "description"),
      pubDate: extractTag(block, "pubDate") || null,
      company:
        extractTag(block, "dc:creator") ||
        extractTag(block, "author") ||
        extractTag(block, "creator") ||
        "",
      location:
        extractTag(block, "dc:subject") ||
        extractTag(block, "category") ||
        "",
    });
  }
  return items;
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export interface RssAdapterOptions {
  name: string;
  tier: 1 | 2 | 3 | 4 | 5;
  vertical: "tech" | "healthcare" | "general";
  /** Build the feed URL from the search profile (called per run) */
  buildFeedUrl(profile: SearchProfile): string;
  /** Fallback company name when the feed item has no creator/author */
  defaultCompany?: string;
  /** Fallback location when the feed item has no location tag */
  defaultLocation?: string;
  rateLimitDelay?: number;
}

export function makeRssAdapter(opts: RssAdapterOptions): SourceAdapter {
  return {
    name: opts.name,
    tier: opts.tier,
    vertical: opts.vertical,
    rateLimitDelay: opts.rateLimitDelay ?? 2000,

    async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
      const url = opts.buildFeedUrl(profile);
      const res = await fetch(url, {
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

      const xml = await res.text();
      const items = parseRssItems(xml);

      const kwLower = profile.keywords.map((k) => k.toLowerCase());

      return items
        .filter((item) => {
          const haystack = `${item.title} ${item.description}`.toLowerCase();
          return kwLower.some((kw) => haystack.includes(kw));
        })
        .map((item) => ({
          url: item.link,
          title: item.title,
          company: item.company || opts.defaultCompany || opts.name,
          location: item.location || opts.defaultLocation || "Australia",
          description: item.description,
          source: opts.name,
          source_tier: opts.tier,
          posted_at: item.pubDate,
          expires_at: null,
          raw: item,
        }));
    },

    async isHealthy(): Promise<boolean> {
      try {
        const url = opts.buildFeedUrl({
          id: "health",
          keywords: ["analyst"],
          location: "Australia",
          visa_filter_mode: "probability_sort",
        });
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
