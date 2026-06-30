// Clinch (PageUp recruitment-marketing) ATS adapter — aged-care providers on
// Clinch career sites. First tenants: Uniting Vic/Tas + Uniting AgeWell.
//
// Clinch's live listing is a Turbo-Stream XHR behind AWS WAF + CMS widget IDs —
// painful to drive headless. BUT Clinch is an SEO platform, so it publishes a
// flat /sitemap.xml of every /jobs/{slug}, and each detail page carries clean
// schema.org JSON-LD JobPosting (full JD + AU address + dates) — verified
// 2026-06-29. So we take the SEO back-door: sitemap → role-taxonomy pre-filter on
// the slug → fetch detail → JSON-LD. No XHR, no CMS IDs.
//
// ⚠ PAUSED 2026-06-29 — AWS WAF blocks bulk detail scraping. A SINGLE curl_cffi
// request to a /jobs/* page returns 200 + JSON-LD, but a SEQUENCE of them (even
// spaced 1.5s) gets 202 challenge interstitials every time — AWS WAF does
// behavioural/session challenging that needs an aws-waf-token minted by its
// JS/WASM SDK (headless only). The sitemap + JSON-LD approach is correct and the
// extractor works; only the WAF gate is unsolved. Re-enable when we have a
// headless/token path (Playwright is OOM-disabled on the 512MB Fly VM, BUG-5) or
// a got-scraping fingerprint that passes. High-value target = Uniting AgeWell
// (35 genuine aged-care roles: home/personal care workers, RN/EN, lifestyle).
// Uniting Vic/Tas is NOT aged care (AOD/family-violence/out-of-home-care) — drop
// it if re-enabling; keep AgeWell only.

import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import { matchRole, stripHtml, sleep } from "./agedCareRoles.js";
import { curlFetch } from "../lib/curlfetch.js";

interface Org { host: string; company: string }

const ORGS: Org[] = [
  { host: "careers.unitingvictas.org.au", company: "Uniting Vic/Tas" }, // ✅ validated 2026-06-29
  { host: "careers.unitingagewell.org",   company: "Uniting AgeWell" }, // same platform (sitemap+JSON-LD)
];

const TIMEOUT_MS      = 15_000;
const MAX_DETAILS     = 80;     // role-matched detail fetches per org (safety cap)
const DETAIL_DELAY_MS = 1500;   // space EVERY detail fetch — AWS WAF rate-challenges bursts
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface JsonLdJobPosting {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: { name?: string };
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }
    | Array<{ address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }>;
}

function firstAddress(jl: JsonLdJobPosting) {
  const loc = jl.jobLocation;
  if (!loc) return undefined;
  return Array.isArray(loc) ? loc[0]?.address : loc.address;
}

function extractJobPosting(html: string): JsonLdJobPosting | null {
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
    } catch { /* malformed — skip */ }
  }
  return null;
}

function slugToTitle(slug: string): string {
  return slug.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml,*/*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 403) return { status: res.status, body: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.text() };
}

// Pull every /jobs/{slug} URL out of the sitemap (flat <loc> list).
function jobUrlsFromSitemap(xml: string, host: string): string[] {
  const re = new RegExp(`https?://${host.replace(/\./g, "\\.")}/jobs/[a-z0-9-]+`, "gi");
  return [...new Set(xml.match(re) ?? [])];
}

export const clinchAdapter: SourceAdapter = {
  name:           "clinch",
  tier:           3,
  vertical:       "healthcare",
  rateLimitDelay: 1200,

  async fetchJobs(_profile: SearchProfile): Promise<RawJob[]> {
    const out: RawJob[] = [];

    for (const o of ORGS) {
      let sitemap: string;
      try {
        ({ body: sitemap } = await fetchText(`https://${o.host}/sitemap.xml`));
      } catch (err) {
        console.warn(`[clinch] ${o.company}: sitemap — ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!sitemap) continue;

      const urls = jobUrlsFromSitemap(sitemap, o.host);
      // Cheap pre-filter on the slug so we only fetch detail pages for care roles.
      const candidates = urls.filter((u) => matchRole(slugToTitle(u.split("/jobs/")[1] ?? "")));
      console.log(`[clinch] ${o.company}: ${urls.length} jobs in sitemap → ${candidates.length} role-matched → fetching JDs`);

      let added = 0;
      let seen = 0;
      for (const url of candidates) {
        if (added >= MAX_DETAILS) break;
        // Space EVERY request (not just successes): AWS WAF rate-challenges
        // bursts, so a no-body 202 must still cost a delay before the next try.
        if (seen++ > 0) await sleep(DETAIL_DELAY_MS);

        // Detail pages sit behind AWS WAF (202 to undici) → curl_cffi bypass.
        let body = "";
        try {
          const r = await curlFetch(url);
          if (r.status === 200) body = r.body;
        } catch { continue; }
        if (!body) continue;

        const jp = extractJobPosting(body);
        if (!jp?.title || !matchRole(jp.title)) continue;

        const addr = firstAddress(jp);
        if (addr?.addressCountry && !/austral/i.test(addr.addressCountry)) continue;
        const location = [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(", ") || "Australia";

        out.push({
          url,
          title:       jp.title,
          company:     jp.hiringOrganization?.name ?? o.company,
          location,
          description: jp.description ? stripHtml(jp.description) : "",
          source:      "agedcare",
          source_tier: 3,
          posted_at:   jp.datePosted ?? null,
          expires_at:  jp.validThrough ?? null,
          raw:         { jsonld: jp },
        });
        added++;
      }
      console.log(`[clinch] ${o.company}: ${added} jobs with full JD`);
      await sleep(this.rateLimitDelay);
    }

    console.log(`[clinch] done — ${out.length} jobs`);
    return out;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const { body } = await fetchText(`https://${ORGS[0].host}/sitemap.xml`);
      return body.includes("/jobs/");
    } catch {
      return false;
    }
  },
};
