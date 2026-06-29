// Avature ATS adapter — aged-care providers on Avature career sites.
// First tenant: Regis Aged Care (regis.avature.net) — 84 homes, ~120 live roles.
//
// Regis's Avature board SERVER-RENDERS the full job list (no JS SPA) AND embeds
// the COMPLETE JD inline in each listing card — verified 2026-06-29. Detail
// pages carry NO schema.org JSON-LD, so instead of fetching every detail page we
// parse the listing directly: each job is one <article class="…article--result">
// with an <h3> title link to /careers/JobDetail/{slug}/{id}, a subtitle holding
// the location/ref/close-date, and an <div class="article__content"> with the
// full JD. That makes this the cheapest aged-care adapter — list-only, no detail
// fetches.
//
// Pagination: the page size is fixed at 6 (jobRecordsPerPage is ignored); walk
// the list via ?jobOffset=0,6,12,… until a page returns no new jobs.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

interface Org { tenant: string; company: string }

const ORGS: Org[] = [
  { tenant: "regis", company: "Regis Aged Care" },   // ✅ validated 2026-06-29
];

const TIMEOUT_MS  = 15_000;
const PAGE_SIZE   = 6;     // Avature serves 6/page regardless of jobRecordsPerPage
const MAX_PAGES   = 40;    // 6 × 40 = 240 ceiling (Regis ≈ 120); loop breaks early
const PAGE_DELAY  = 500;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function origin(o: Org): string { return `https://${o.tenant}.avature.net`; }
function listUrl(o: Org, offset: number): string {
  return `${origin(o)}/en_US/careers/SearchJobs/?jobRecordsPerPage=${PAGE_SIZE}&jobOffset=${offset}`;
}

// One listing job card: <article …article--result …> … </article>
const ARTICLE_RE = /<article[^>]*\barticle--result\b[^>]*>([\s\S]*?)<\/article>/gi;
// Title link inside the card's <h3 …title>: clean main /JobDetail/{slug}/{id}.
const TITLE_RE   = /<h3[^>]*article__header__text__title[^>]*>[\s\S]*?<a[^>]*href="([^"]+\/JobDetail\/[^"?]+)"[^>]*>([\s\S]*?)<\/a>/i;
const LOC_RE     = /<span class="list-item-location">([\s\S]*?)<\/span>/i;
const REF_RE     = /<span class="list-item-ref">([\s\S]*?)<\/span>/i;
const DATE_RE    = /<span class="list-item-date">([\s\S]*?)<\/span>/i;
const ID_RE      = /\/JobDetail\/[^/]+\/(\d+)/;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "Close date 31-Jul-2026" → "2026-07-31" (best-effort; null on miss).
function parseCloseDate(text: string): string | null {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

interface ParsedJob { url: string; jobId: string; title: string; location: string; ref: string; description: string; expires: string | null }

function parseListing(html: string, o: Org): ParsedJob[] {
  const out: ParsedJob[] = [];
  let a: RegExpExecArray | null;
  const re = new RegExp(ARTICLE_RE.source, "gi");
  while ((a = re.exec(html)) !== null) {
    const block = a[1];

    const t = TITLE_RE.exec(block);
    if (!t) continue;
    const href = t[1].startsWith("http") ? t[1] : `${origin(o)}${t[1]}`;
    const title = stripHtml(t[2]);
    if (!title) continue;

    const jobId = ID_RE.exec(href)?.[1] ?? href;
    const location = stripHtml(LOC_RE.exec(block)?.[1] ?? "");
    const ref = stripHtml(REF_RE.exec(block)?.[1] ?? "");
    const expires = parseCloseDate(stripHtml(DATE_RE.exec(block)?.[1] ?? ""));

    // Full JD is the article__content body. Slice from it to the card end, then
    // cut the trailing social-share UI (each card ends with shareButton links).
    let description = "";
    const cIdx = block.indexOf('article__content"');
    if (cIdx >= 0) {
      const tail = block.slice(block.indexOf(">", cIdx) + 1);
      description = stripHtml(tail.split(/shareButton|<ul[^>]*share|article__footer/i)[0]);
    }

    out.push({ url: href, jobId, title, location, ref, description, expires });
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "portalLanguage-15=en_US",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const avatureAdapter: SourceAdapter = {
  name:           "avature",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const o of ORGS) {
      const seen = new Set<string>();
      let matched = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        let html = "";
        try {
          html = await fetchText(listUrl(o, page * PAGE_SIZE));
        } catch (err) {
          console.warn(`[avature] ${o.company}: ${err instanceof Error ? err.message : err}`);
          break;
        }
        if (!html) break;

        const jobs = parseListing(html, o);
        if (jobs.length === 0) break;

        let fresh = 0;
        for (const j of jobs) {
          if (seen.has(j.jobId)) continue;
          seen.add(j.jobId);
          fresh++;

          // Curated aged-care stream: keep only taxonomy-matched titles.
          if (!matchRole(j.title)) continue;

          out.push({
            url:         j.url,
            title:       j.title,
            company:     o.company,
            location:    j.location || "Australia",
            description: j.description,
            source:      "agedcare",
            source_tier: 3,
            posted_at:   null,
            expires_at:  j.expires,
            raw:         { jobId: j.jobId, ref: j.ref },
          });
          matched++;
        }
        if (fresh === 0) break;   // no new jobs on this page → end of list
        await sleep(PAGE_DELAY);
      }

      console.log(`[avature] ${o.company}: ${seen.size} listed → ${matched} role-matched with full JD`);
    }

    console.log(`[avature] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      return (await fetchText(listUrl(ORGS[0], 0))).includes("/JobDetail/");
    } catch {
      return false;
    }
  },
};
