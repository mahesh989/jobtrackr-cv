// AdLogic (MartianLogic / myRecruitment+) ATS adapter — aged-care employers on
// AdLogic job boards. First tenant: Moran Health Care (careers.morangroup.com.au).
//
// AdLogic boards are a Next.js frontend over a public JSON API, so we get a clean
// list endpoint plus full JDs — no HTML scraping of the listing needed. Multi-
// tenant (Moran, Maroba Aged Care, …) → one adapter unlocks several AU aged-care
// providers (add a row to ORGS after the 2-request recon).
//
// Two public endpoints per tenant (verified against Moran 2026-07-01):
//   1. LIST   GET /api/search/?clientCode={code}&page=N&filter=&systemFilter=
//             → { total, pageSize(=10), jobAds:[{ id, title, location "Suburb | State",
//                 description(short teaser ~150 chars), classification, ... }] }
//             Paginate `page` until we've collected `total`.
//   2. DETAIL GET /{clientCode}/{id}/     (Next.js SSR page)
//             → HTML embedding <script id="__NEXT_DATA__">…</script> whose
//               props.pageProps.ad.body is the FULL JD (HTML). We parse that
//               rather than the /_next/data/{buildId}/… JSON endpoint because the
//               buildId rotates on every site deploy; the page path is stable.
//
// Cost discipline: the LIST teaser is too thin for analysis, so a DETAIL fetch
// (full JD) is spent ONLY on titles matching the aged-care role taxonomy.
//
// Job/apply URL: https://{host}/{clientCode}/{id}/  (human page with apply button).

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";

interface Org { host: string; clientCode: string; company: string }

const ORGS: Org[] = [
  { host: "careers.morangroup.com.au", clientCode: "moran", company: "Moran Health Care" }, // ✅ recon'd 2026-07-01
];

const TIMEOUT_MS      = 15_000;
const MAX_PAGES       = 50;    // safety ceiling; loop stops once `total` is collected
const DETAIL_DELAY_MS = 300;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface AdLogicJob {
  id: number;
  title?: string;
  location?: string;      // "Stockton | New South Wales"
  description?: string;   // short teaser
  type?: string;
}
interface AdLogicSearch { total?: number; pageSize?: number; jobAds?: AdLogicJob[] }

function searchUrl(o: Org, page: number): string {
  const p = new URLSearchParams({ clientCode: o.clientCode, page: String(page), filter: "", systemFilter: "" });
  return `https://${o.host}/api/search/?${p.toString()}`;
}
function jobUrl(o: Org, id: number): string {
  return `https://${o.host}/${o.clientCode}/${id}/`;
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/json,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: url,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return { status: res.status, body: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.text() };
}

// "Stockton | New South Wales" → "Stockton, New South Wales" (pipeline normalises
// the state name → NSW). Falls back to the raw string / "Australia".
function parseLocation(raw?: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "Australia";
  const parts = s.split("|").map((x) => x.trim()).filter(Boolean);
  return parts.join(", ") || "Australia";
}

interface AdDetail { body?: string; publishDate?: string; applictionURL?: string; subLocation?: string; location?: string }

// Pull the full-JD ad object out of the SSR page's __NEXT_DATA__ blob.
function extractAd(html: string): AdDetail | null {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]) as {
      props?: { pageProps?: { ad?: AdDetail } };
      pageProps?: { ad?: AdDetail };
    };
    return data.props?.pageProps?.ad ?? data.pageProps?.ad ?? null;
  } catch {
    return null;
  }
}

function toIso(d?: string): string | null {
  if (!d) return null;
  try {
    const iso = new Date(d.replace(" ", "T")).toISOString();
    return iso;
  } catch {
    return null;
  }
}

export const adlogicAdapter: SourceAdapter = {
  name:           "adlogic",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1200,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const o of ORGS) {
      // 1) Page the cheap LIST endpoint and collect title-matched jobs.
      const matched: AdLogicJob[] = [];
      let total = Infinity;
      let listFailed = false;

      for (let page = 1; page <= MAX_PAGES; page++) {
        let resp: AdLogicSearch;
        try {
          const { body } = await fetchText(searchUrl(o, page));
          resp = body ? (JSON.parse(body) as AdLogicSearch) : {};
        } catch (err) {
          console.warn(`[adlogic] ${o.company} list page ${page}: ${err instanceof Error ? err.message : err}`);
          listFailed = true;
          break;
        }
        const ads = resp.jobAds ?? [];
        if (resp.total !== undefined) total = resp.total;
        if (ads.length === 0) break;

        for (const j of ads) if (j.title && matchRole(j.title)) matched.push(j);
        const pageSize = resp.pageSize || ads.length || 10;
        if (page * pageSize >= total) break;
        await sleep(400);
      }

      if (listFailed && matched.length === 0) {
        console.warn(`[adlogic] ${o.company}: list endpoint unreachable — skipping`);
        continue;
      }
      console.log(`[adlogic] ${o.company}: ${matched.length} role-matched → fetching JDs`);

      // 2) Spend a DETAIL fetch (full JD via __NEXT_DATA__) only on role matches.
      let added = 0;
      for (const j of matched) {
        const url = jobUrl(o, j.id);
        let ad: AdDetail | null = null;
        try {
          const { body } = await fetchText(url);
          if (body) ad = extractAd(body);
        } catch { /* skip on error */ }

        const jd = ad?.body ? stripHtml(ad.body) : "";
        // Fall back to the list teaser if the detail JD is missing.
        const description = jd || stripHtml(j.description ?? "");

        out.push({
          url,
          title:       j.title!,
          company:     o.company,
          location:    parseLocation(j.location),
          description,
          source:      "agedcare",
          source_tier: 3,
          posted_at:   toIso(ad?.publishDate),
          expires_at:  null,
          raw:         { id: j.id, applyUrl: ad?.applictionURL, list: j },
        });
        added++;
        await sleep(DETAIL_DELAY_MS);
      }
      console.log(`[adlogic] ${o.company}: ${added} jobs with full JD`);
      await sleep(this.rateLimitDelay);
    }

    console.log(`[adlogic] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { body } = await fetchText(searchUrl(ORGS[0], 1));
      const resp = body ? (JSON.parse(body) as AdLogicSearch) : {};
      return (resp.jobAds?.length ?? 0) >= 0 && resp.total !== undefined;
    } catch {
      return false;
    }
  },
};
