// PageUp ATS adapter — aged-care / healthcare providers on PageUp.
//
// PageUp boards live on shared hosts under a numeric INSTANCE id + a per-client
// SOURCE code: https://careers.pageuppeople.com/{instance}/{source}/en/listing/
// (BaptistCare=999/ci, Calvary=1106/cw, Arcare=1073/arc, SA Health=532/caw —
// listings validated 2026-06-29: each returns ~20 server-rendered job links.)
//
// ⚠ DEGRADED MODE (listing-only). Modern PageUp job DETAIL pages are a JS SPA
// (Stimulus/Hotwire) with NO schema.org JSON-LD (verified 2026-06-29), so we
// cannot scrape the full JD from the detail HTML. This adapter therefore emits
// only what the listing exposes: the job URL + a title derived from the link
// slug, role-filtered. Descriptions are empty until we capture PageUp's job
// JSON API from the browser network tab (see docs/aged-care-ats-map.md).
//
// Resthaven (1140/aw) is excluded: it uses the newer PageUp that redirects to a
// custom domain (careers.resthaven.asn.au/jobs/search) — different shape, TODO.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, sleep } from "./agedCareRoles.js";

interface Org {
  instance: string;
  source:   string;
  company:  string;
  host?:    string;   // default careers.pageuppeople.com
}

const ORGS: Org[] = [
  { instance: "999",  source: "ci",  company: "BaptistCare" },
  { instance: "1106", source: "cw",  company: "Calvary Health Care" },
  { instance: "1073", source: "arc", company: "Arcare" },
  { instance: "532",  source: "caw", company: "SA Health" },
];

const TIMEOUT_MS       = 15_000;
const MAX_JOBS_PER_ORG = 60;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function host(o: Org): string { return o.host ?? "careers.pageuppeople.com"; }
function listingUrl(o: Org): string { return `https://${host(o)}/${o.instance}/${o.source}/en/listing/`; }

// Job-detail links: .../en/job/{id}/{slug}. Capture id + slug.
const JOB_LINK_RE = /\/(\d+)\/([a-z0-9-]+)\/en\/job\/(\d+)\/([a-z0-9-]+)/gi;

// "lifestyle-officer-warena-centre" → "Lifestyle Officer Warena Centre"
function slugToTitle(slug: string): string {
  return slug.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return "";
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const pageupAdapter: SourceAdapter = {
  name:           "pageup",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1500,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const jobs: RawJob[] = [];

    for (const o of ORGS) {
      let listing: string;
      try {
        listing = await fetchText(listingUrl(o));
      } catch (err) {
        console.warn(`[pageup] ${o.company} (${o.instance}): ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!listing) continue;

      const seen = new Set<string>();
      let added = 0;
      let m: RegExpExecArray | null;
      const re = new RegExp(JOB_LINK_RE.source, "gi");
      while ((m = re.exec(listing)) !== null && added < MAX_JOBS_PER_ORG) {
        const [, inst, src, id, slug] = m;
        if (seen.has(id)) continue;
        seen.add(id);

        const title = slugToTitle(slug);
        if (!matchRole(title)) continue;

        jobs.push({
          url:         `https://${host(o)}/${inst}/${src}/en/job/${id}/${slug}`,
          title,
          company:     o.company,
          location:    "Australia",      // listing-only; real location needs the JD API
          description: "",               // ⚠ degraded — no JD until PageUp JSON API captured
          source:      "agedcare",
          source_tier: 3,
          posted_at:   null,
          expires_at:  null,
          raw:         { instance: inst, source: src, id, slug, degraded: true },
        });
        added++;
      }
      console.log(`[pageup] ${o.company} (${o.instance}): ${added} role-matched links (listing-only, no JD)`);
      await sleep(this.rateLimitDelay);
    }

    return jobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      return (await fetchText(listingUrl(ORGS[0]))).length > 0;
    } catch {
      return false;
    }
  },
};
