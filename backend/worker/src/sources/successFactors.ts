// SuccessFactors (SAP) ATS adapter — aged-care employers on SuccessFactors
// "Career Site Builder" (CSB) career sites. First tenant: Australian Unity
// (careers.australianunity.com.au).
//
// Why SuccessFactors is a PRIME target: it's one of the most common enterprise
// ATSs in AU, so ONE adapter unlocks MANY aged-care providers (the same leverage
// Workday gave us). Adding a provider = one row in ORGS (after a 2-curl recon).
//
// Shape (validated against Australian Unity 2026-06-30):
//   1. LIST   GET /search/?q=&startrow=N   (25/page; paginate via startrow)
//             → server-rendered HTML with /job/{slug}/{id}/ links. Slugs are
//               rich: "{Suburb}-{Title}-{STATE}-{postcode}".
//   2. DETAIL GET {job link}  →  NO schema.org JSON-LD here. The full JD lives in
//             <span itemprop="description" class="jobdescription">…</span> and the
//             role title in <title>{Title} Job Details | {Company}</title>.
//   So: collect links → role-taxonomy pre-filter on the de-slugged path → fetch
//   detail → <title> for title + balanced jobdescription span for the JD +
//   suburb/STATE parsed from the slug. (A JSON-LD path is kept as a fallback for
//   future SF tenants whose CSB theme does emit it.)
//
// Bot layer: CSB sits behind Imperva (visid_incap/incap_ses) but it's passive
// here — plain fetch + a realistic UA passes (listing 200, detail 200, 55 KB).
// If a SEQUENCE ever starts returning challenge interstitials (Clinch-style AWS
// WAF), this would need a cookie bootstrap or headless path.
//
// Validated 2026-06-30: 99 links → 65 role-matched. Fails safe (returns [] /
// throws → orchestrator skips), so enabling cannot break runs.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

interface Org { host: string; company: string }

const ORGS: Org[] = [
  { host: "careers.australianunity.com.au", company: "Australian Unity" }, // ✅ validated 2026-06-30 (89 JDs)
  { host: "careers.irt.org.au",             company: "IRT Group" },        // ✅ validated 2026-06-30 (26 links → 11 care-role full JDs; same jobdescription span)
];

const TIMEOUT_MS      = 15_000;
const PAGE_SIZE       = 25;    // CSB default block size; paginate via ?startrow=
const MAX_PAGES       = 40;    // 25 × 40 = 1000 ceiling; loop breaks early when a page yields no new links
const DETAIL_DELAY_MS = 300;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// CSB job-detail links: /job/{slug}/{jobId}/ (trailing slash optional). Slugs can
// contain %2C (encoded comma) and &amp; (encoded ampersand), so match anything up
// to the closing quote — only stop at quotes/space/brackets. The trailing numeric
// id is the stable de-dupe key.
const JOB_LINK_RE = /\/job\/([^"'\s<>]+?\/\d+)\/?(?=["'\s<>])/gi;
const JOB_ID_RE   = /\/(\d+)$/;

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
// Slug tokens that mark where the role TITLE begins (everything before the first
// one is the suburb). Lower-cased for comparison.
const ROLE_START_TOKENS = new Set([
  "home", "personal", "care", "support", "registered", "enrolled", "clinical",
  "nurse", "lifestyle", "administration", "admin", "carer", "aged", "ain", "rn",
  "en", "coordinator", "assistant", "worker", "partner", "companion", "allied",
  "physiotherapist", "manager", "cook", "chef", "hospitality", "cleaner",
]);

interface JsonLdJobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: { name?: string };
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string } }
    | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>;
}

function extractJsonLd(html: string): JsonLdJobPosting | null {
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]) as unknown;
      for (const item of (Array.isArray(data) ? data : [data])) {
        if (item && typeof item === "object" && (item as Record<string, unknown>)["@type"] === "JobPosting") {
          return item as JsonLdJobPosting;
        }
      }
    } catch { /* skip malformed JSON-LD */ }
  }
  return null;
}

// Pull the role title from <title>…</title>, stripping the CSB-generic
// "Job Details" + "| {Company}" suffix. e.g.
//   "Personal Care Worker / AIN Job Details | Australian Unity" → "Personal Care Worker / AIN"
function titleFromHead(html: string): string {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return "";
  return stripHtml(m[1])
    .replace(/\s*Job Details\s*\|.*$/i, "")
    .replace(/\s*\|\s*[^|]*$/, "")
    .replace(/\s*Job Details\s*$/i, "")
    .trim();
}

// The JD is <span itemprop="description" class="jobdescription">…</span>; the body
// itself nests <span>s, so walk the tags balancing depth to find the true close.
function extractJobDescription(html: string): string {
  const anchor = html.search(/class="jobdescription"/i);
  if (anchor < 0) return "";
  const contentStart = html.indexOf(">", anchor) + 1;
  if (contentStart <= 0) return "";

  let depth = 1;
  const re = /<\/?span\b[^>]*>/gi;
  re.lastIndex = contentStart;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return stripHtml(html.slice(contentStart, m.index));
  }
  return stripHtml(html.slice(contentStart)); // unbalanced — take the rest
}

// "Glen-Waverley-Personal-Care-Worker-AIN-VIC-3150" → "Glen Waverley, VIC".
// Suburb = tokens before the first role-keyword token; STATE = AU state code.
function locationFromSlug(slug: string): string {
  const decoded = decodeURIComponent(slug).replace(/&amp;/gi, "&");
  const tokens = decoded.split("-").map((t) => t.trim()).filter(Boolean);

  const state = tokens.find((t) => AU_STATES.includes(t.toUpperCase()));
  const suburb: string[] = [];
  for (const t of tokens) {
    if (ROLE_START_TOKENS.has(t.toLowerCase().replace(/[^a-z]/g, ""))) break;
    suburb.push(t);
  }
  const suburbStr = suburb.join(" ").replace(/\s*,\s*/g, ", ").trim();
  if (!suburbStr) return state ? `Australia, ${state.toUpperCase()}` : "Australia";
  return state ? `${suburbStr}, ${state.toUpperCase()}` : suburbStr;
}

// De-slugged path words for the cheap pre-filter (a superset of the title, so it
// never drops a real match — location slugs simply don't hit the role taxonomy).
function pathToWords(path: string): string {
  return decodeURIComponent(path).replace(/&amp;/gi, " ").replace(/^\/job\//i, "").replace(/[/_-]+/g, " ").trim();
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/json",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return { status: res.status, body: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.text() };
}

function searchUrl(host: string, startrow: number): string {
  const params = new URLSearchParams({
    q: "",
    sortColumn: "referencedate",
    sortDirection: "desc",
    startrow: String(startrow),
  });
  return `https://${host}/search/?${params.toString()}`;
}

// Collect job-detail paths across pages. jobId (trailing number) → slug path.
async function collectLinks(o: Org): Promise<Map<string, string>> {
  const links = new Map<string, string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    let body = "";
    try {
      ({ body } = await fetchText(searchUrl(o.host, page * PAGE_SIZE), {
        Referer: `https://${o.host}/search/`,
      }));
    } catch { break; }
    if (!body) break;

    const before = links.size;
    let m: RegExpExecArray | null;
    const re = new RegExp(JOB_LINK_RE.source, "gi");
    while ((m = re.exec(body)) !== null) {
      const path = `/job/${m[1]}`;
      const id = JOB_ID_RE.exec(path)?.[1];
      if (id && !links.has(id)) links.set(id, path);
    }
    if (links.size === before) break;   // no new links on this page → done
    await sleep(400);
  }

  return links;
}

export const successFactorsAdapter: SourceAdapter = {
  name:           "successfactors",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1200,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const o of ORGS) {
      let links: Map<string, string>;
      try {
        links = await collectLinks(o);
      } catch (err) {
        console.warn(`[successfactors] ${o.company}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      // Cheap pre-filter on the de-slugged path to skip detail fetches for
      // non-care roles (finance, IT, customer service, etc.).
      const candidates = [...links.entries()].filter(([, path]) => matchRole(pathToWords(path)));
      console.log(`[successfactors] ${o.company}: ${links.size} links → ${candidates.length} role-matched → fetching JDs`);

      let added = 0;
      for (const [jobId, path] of candidates) {
        // CSB serves the detail page WITH a trailing slash; keep it.
        const url = `https://${o.host}${path}/`;
        let body = "";
        try {
          ({ body } = await fetchText(url));
        } catch { continue; }
        if (!body) continue;

        const jsonld = extractJsonLd(body);   // fallback for CSB themes that emit it
        const title = jsonld?.title || titleFromHead(body);
        if (!title || !matchRole(title)) continue;

        const description = (jsonld?.description ? stripHtml(jsonld.description) : "") || extractJobDescription(body);
        if (!description || description.length < 50) continue;   // skip thin/empty JDs

        // Slug = path minus "/job/" prefix and "/{id}" suffix.
        const slug = path.replace(/^\/job\//i, "").replace(/\/\d+$/, "");
        const location = locationFromSlug(slug);

        out.push({
          url,
          title,
          company:     jsonld?.hiringOrganization?.name ?? o.company,
          location,
          description,
          source:      "agedcare",
          source_tier: 3,
          posted_at:   jsonld?.datePosted ?? null,
          expires_at:  jsonld?.validThrough ?? null,
          raw:         { jobId, slug, path },
        });
        added++;
        await sleep(DETAIL_DELAY_MS);
      }
      console.log(`[successfactors] ${o.company}: ${added} jobs with full JD`);
      await sleep(this.rateLimitDelay);
    }

    console.log(`[successfactors] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { body } = await fetchText(searchUrl(ORGS[0].host, 0));
      return body.includes("/job/");
    } catch {
      return false;
    }
  },
};
