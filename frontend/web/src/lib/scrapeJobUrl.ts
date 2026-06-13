// DEFERRED FEATURE — Tier 4 user-initiated JD URL fetch
//
// Status: built, not wired up. No API route calls this.
// Intended use: user pastes a job URL into the manual JD edit flow,
//   this fetches and pre-populates the JD text field.
// Distinct from backend/api/services/scraping/jd_scraper.py, which runs
//   during analysis from a known JD source.
// To activate: create POST /api/jobs/scrape-url that calls scrapeJobUrl()
//   and returns { jdText, source }. Wire to a "Fetch from URL" button on
//   the JD edit modal.

/**
 * scrapeJobUrl — Tier 4 user-initiated job page fetcher.
 *
 * A human user supplies a URL; this runs a single GET on their behalf,
 * exactly as if they pressed Ctrl+U. No bulk crawling, no automation.
 *
 * Extraction priority:
 *   1. JSON-LD (schema.org/JobPosting) — most modern job boards include
 *      this for Google indexing; gives structured title/company/location/JD.
 *   2. OpenGraph meta tags — reliable fallback for title + description.
 *   3. HTML parsing — <main>/<article>/<body> content + <h1> title.
 *
 * Works with: EthicalJobs, Seek (SSR pages), LinkedIn (public), any SSR
 * job board. Returns a clear error if the page requires JS to render.
 */

const NOISE_TAGS = [
  "script", "style", "nav", "footer", "header",
  "aside", "form", "svg", "iframe", "noscript",
];

// ── HTML helpers ──────────────────────────────────────────────────────────────

function stripTagBlock(html: string, tag: string): string {
  return html.replace(
    new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"),
    " "
  );
}

/** Pull content="..." from a <meta property/name="X"> tag. */
function getMeta(html: string, property: string): string | null {
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']{1,400})["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']{1,400})["'][^>]+(?:property|name)=["']${esc}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Extract inner text of a tag (single, first occurrence). */
function getTagText(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{1,600}?)<\\/${tag}>`, "i"));
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;
}

/** Strip HTML to readable plain text. */
function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|blockquote)[^>]*>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── JSON-LD extraction ────────────────────────────────────────────────────────

interface JobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: {
    address?: {
      addressLocality?: string;
      addressRegion?: string;
      addressCountry?: string;
    };
  } | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>;
  datePosted?: string;
}

function extractJsonLd(html: string): JobPosting | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data: unknown = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (
          item &&
          typeof item === "object" &&
          (item as JobPosting)["@type"] === "JobPosting"
        ) {
          return item as JobPosting;
        }
      }
    } catch {
      // malformed JSON — skip
    }
  }
  return null;
}

function ldLocation(ld: JobPosting): string | null {
  const loc = ld.jobLocation;
  if (!loc) return null;
  const addr = Array.isArray(loc) ? loc[0]?.address : loc.address;
  if (!addr) return null;
  return [addr.addressLocality, addr.addressRegion]
    .filter(Boolean)
    .join(", ") || null;
}

// ── Title cleaning ────────────────────────────────────────────────────────────

/**
 * Given a raw page title like "Data Analyst at Canopy | EthicalJobs",
 * returns { role: "Data Analyst", company: "Canopy" }.
 * Falls back gracefully when the pattern isn't matched.
 */
function parseTitle(raw: string): { role: string; company: string | null } {
  // Strip site suffix: everything after | – — ·
  const withoutSite = raw.split(/\s*[|–—·]\s*/)[0].trim();

  // "Role at Company" pattern
  const atIdx = withoutSite.search(/\s+at\s+/i);
  if (atIdx !== -1) {
    return {
      role: withoutSite.slice(0, atIdx).trim(),
      company: withoutSite.slice(atIdx).replace(/^\s+at\s+/i, "").trim(),
    };
  }

  // Fallback: no company in title
  return { role: withoutSite, company: null };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ScrapedJob {
  title: string;
  company: string | null;
  location: string | null;
  description: string;
  source_url: string;           // canonical URL (query params stripped)
  posted_at: string | null;     // ISO string if found in JSON-LD, else null
}

export async function scrapeJobUrl(rawUrl: string): Promise<ScrapedJob> {
  // ── 1. Validate ────────────────────────────────────────────────────────────
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL — must start with https://");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid URL — must start with https://");
  }

  // Canonical URL: strip query params & fragment
  const cleanUrl = `${parsed.origin}${parsed.pathname}`;

  // ── 2. Fetch (2 MB cap) ───────────────────────────────────────────────────
  const res = await fetch(rawUrl, {
    headers: {
      "User-Agent":      "JobTrackrBot/1.0 (+https://jobtrackr.app/bot)",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
      "Cache-Control":   "no-cache",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Page returned HTTP ${res.status} — check the URL and try again.`);
  }

  // Stream up to 2 MB
  const MAX_BYTES = 2 * 1024 * 1024;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body received.");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalBytes += value.byteLength;
      if (totalBytes >= MAX_BYTES) { reader.cancel(); break; }
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) { combined.set(c, offset); offset += c.byteLength; }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(combined);

  // ── 3. JSON-LD path (preferred) ───────────────────────────────────────────
  const ld = extractJsonLd(html);
  if (ld) {
    const rawTitle = ld.title ?? getMeta(html, "og:title") ?? getTagText(html, "title") ?? "Untitled";
    const { role, company: titleCompany } = parseTitle(rawTitle);

    const company =
      ld.hiringOrganization?.name?.trim() ||
      titleCompany ||
      null;

    const location = ldLocation(ld) ?? getMeta(html, "og:locality") ?? null;

    // ld.description is typically HTML — strip it
    const description = ld.description
      ? htmlToPlain(ld.description).slice(0, 20_000)
      : "";

    if (description.length < 200) {
      throw new Error(
        "Job description is too short — the page may require JavaScript to load. " +
        "Try copying the job text manually."
      );
    }

    return {
      title: role,
      company,
      location,
      description,
      source_url: cleanUrl,
      posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
    };
  }

  // ── 4. HTML fallback path ─────────────────────────────────────────────────
  // Strip noise blocks first
  let cleaned = html;
  for (const tag of NOISE_TAGS) cleaned = stripTagBlock(cleaned, tag);

  // Title
  const rawTitle =
    getMeta(cleaned, "og:title") ||
    getTagText(cleaned, "title") ||
    getTagText(cleaned, "h1") ||
    "Untitled";
  const { role, company: titleCompany } = parseTitle(rawTitle);
  const company = titleCompany ?? null;
  const location = getMeta(cleaned, "og:locality") ?? null;

  // Best content container
  const contentHtml =
    cleaned.match(/<main[^>]*>([\s\S]+?)<\/main>/i)?.[1] ??
    cleaned.match(/<article[^>]*>([\s\S]+?)<\/article>/i)?.[1] ??
    cleaned.match(/<[^>]+role=["']main["'][^>]*>([\s\S]+?)<\/[^>]+>/i)?.[1] ??
    cleaned;

  const description = htmlToPlain(contentHtml).slice(0, 20_000);

  if (description.length < 200) {
    throw new Error(
      "Page content is too short — this job listing likely requires JavaScript to load. " +
      "Try copying the job description text manually."
    );
  }

  return {
    title: role,
    company,
    location,
    description,
    source_url: cleanUrl,
    posted_at: null,
  };
}
