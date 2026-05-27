// Careerjet AU adapter — direct HTML scraping via Python curl_cffi.
// Replaces the old API-based approach to bypass jobviewtrack.com's strict Datacenter blocklist.
// No Apify actor required, and no Residential Proxy required!
//
// Phase 1 — Listings (fetchJobs)
//   • curlFetch https://www.careerjet.com.au/search/jobs
//   • Chrome 124 TLS impersonation easily bypasses Cloudflare Turnstile on the main domain.
//   • Parses HTML with cheerio.
//
// Phase 2 — Full JDs (enrichWithCareerjetJDs)
//   • curlFetch https://www.careerjet.com.au/jobad/<hash>
//   • Parses the content section directly.

import * as cheerio from "cheerio";
import type { SourceAdapter, SearchProfile, RawJob } from "./types.js";
import type { NormalisedJob } from "../pipeline/types.js";
import { curlFetch } from "../lib/curlfetch.js";

const MAX_PAGES = 4;
const FIRST_RUN_MAX_PAGES = 6;
const KEYWORD_DELAY = 800;
const JD_DELAY = 600;
const PAGE_DELAY = 800;
const JD_FETCH_CAP = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSalary(text: string | undefined | null): { salary_min?: number; salary_max?: number } {
  if (!text) return {};
  const nums = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return {};
  const isHourly = /per hour|hourly|\/hr/i.test(text);
  const isDaily = /per day|daily/i.test(text);
  const isWeekly = /per week|weekly/i.test(text);
  const isMonthly = /per month|monthly/i.test(text);

  const [lo, hi] = nums;
  const scale = isHourly ? 2080 : isDaily ? 260 : isWeekly ? 52 : isMonthly ? 12 : 1;
  return {
    salary_min: lo ? Math.round(lo * scale) : undefined,
    salary_max: Math.round((hi ?? lo) * scale),
  };
}

export const careerjetAdapter: SourceAdapter = {
  name: "careerjet",
  tier: 1,
  vertical: "general",
  rateLimitDelay: 1000,

  async fetchJobs(profile: SearchProfile): Promise<RawJob[]> {
    const allJobs: RawJob[] = [];
    const seenUrls = new Set<string>();

    const maxPages = profile.is_first_run ? FIRST_RUN_MAX_PAGES : MAX_PAGES;
    const location = profile.location.trim().toLowerCase() === "all australia" ? "" : profile.location;

    console.log(`[careerjet] keywords: ${profile.keywords.join(", ")} · location: ${location || "(AU-wide)"} · HTML Scrape`);

    for (let i = 0; i < profile.keywords.length; i++) {
      const keyword = profile.keywords[i].trim();
      if (!keyword) continue;

      let keywordCount = 0;

      for (let page = 1; page <= maxPages; page++) {
        const queryParams = new URLSearchParams({
          s: keyword,
          l: location,
          p: String(page)
        });
        const url = `https://www.careerjet.com.au/search/jobs?${queryParams.toString()}`;
        
        let body = "";
        let status = 0;
        try {
          // No proxy needed, curl_cffi handles Turnstile naturally
          const res = await curlFetch(url);
          status = res.status;
          body = res.body;
        } catch (err) {
          console.error(`[careerjet] "${keyword}" page ${page} error: ${err instanceof Error ? err.message : err}`);
          break;
        }

        if (status !== 200) {
          console.error(`[careerjet] HTTP ${status} on page ${page}`);
          break;
        }

        const $ = cheerio.load(body);
        const articles = $("article.job");
        if (articles.length === 0) {
          break;
        }

        let pageAdded = 0;
        articles.each((_, el) => {
          const $el = $(el);
          const $a = $el.find("header h2 a");
          const title = $a.text().trim();
          if (!title) return;

          const href = $a.attr("href");
          if (!href) return;
          const jobUrl = `https://www.careerjet.com.au${href}`;
          
          const baseUrl = jobUrl.split("?")[0];
          if (seenUrls.has(baseUrl)) return;
          seenUrls.add(baseUrl);

          const company = $el.find("p.company").text().trim() || "";
          
          let locText = "";
          $el.find("ul.location li").each((_, li) => {
            locText += $(li).text().trim() + " ";
          });
          locText = locText.trim() || profile.location;

          const salaryText = $el.find("ul.salary").text().trim();
          const { salary_min, salary_max } = parseSalary(salaryText);

          const description = $el.find("div.desc").text().trim();

          const rawJob: RawJob = {
            url: jobUrl,
            title,
            company,
            location: locText,
            description,
            source: "careerjet",
            source_tier: 1,
            posted_at: null, // HTML scrape doesn't provide exact dates reliably, defaults to null for fresh discovery
            expires_at: null,
            ...(salary_min !== undefined && { salary_min }),
            ...(salary_max !== undefined && { salary_max }),
            raw: { _keyword: keyword, _salaryText: salaryText }
          };

          allJobs.push(rawJob);
          keywordCount++;
          pageAdded++;
        });

        console.log(`[careerjet] "${keyword}" page ${page}/${maxPages}: added ${pageAdded}, kw total ${keywordCount}, all total ${allJobs.length}`);

        if (articles.length < 10) break; // If few items, assume last page
        if (page < maxPages) await sleep(PAGE_DELAY);
      }
      if (i < profile.keywords.length - 1) await sleep(KEYWORD_DELAY);
    }

    console.log(`[careerjet] done — ${allJobs.length} unique jobs across ${profile.keywords.length} keyword(s)`);
    return allJobs;
  },

  async isHealthy(): Promise<boolean> {
    try {
      const res = await curlFetch("https://www.careerjet.com.au/search/jobs?s=analyst&l=Sydney");
      return res.status === 200 && res.body.includes("article class=\"job");
    } catch {
      return false;
    }
  }
};

const CAREERJET_HOST = "www.careerjet.com.au";
export const CAREERJET_JD_FETCH_CAP = JD_FETCH_CAP;

function extractJobadDescription(html: string): string {
  const $ = cheerio.load(html);
  const content = $("section.content").text().trim();
  if (content) return content;
  
  // Fallback regex if structure changes
  const m = html.match(/<div[^>]+class="container"[^>]*>([\s\S]+?)<\/div>\s*<div[^>]+class="(?:links|off|footer)/);
  if (!m) return "";

  const text = m[1]
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi,   " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/\s+/g, " ")
    .trim();

  const jobDescMatch = text.match(/job description[:\s]*/i);
  if (jobDescMatch && jobDescMatch.index !== undefined) {
    return text.slice(jobDescMatch.index + jobDescMatch[0].length).trim();
  }
  return text;
}

export async function enrichWithCareerjetJDs(
  jobs: NormalisedJob[],
  cap: number = JD_FETCH_CAP,
): Promise<{ jobs: NormalisedJob[]; costUsd: number; merged: number; fetched: number }> {
  const targets = jobs.filter((j) => j.source === "careerjet" && j.url).slice(0, cap);
  if (targets.length === 0) {
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  const careerjetTargets = targets.filter((j) => {
    try { return new URL(j.url).hostname === CAREERJET_HOST; } catch { return false; }
  });

  if (careerjetTargets.length === 0) {
    console.log(`[careerjet-jd] no careerjet.com.au URLs to enrich`);
    return { jobs, costUsd: 0, merged: 0, fetched: 0 };
  }

  console.log(`[careerjet-jd] enriching ${careerjetTargets.length}/${targets.length} careerjet.com.au survivors · HTML Scrape`);

  const descByUrl = new Map<string, string>();
  let attempted = 0;

  for (const job of careerjetTargets) {
    attempted++;
    try {
      const result = await curlFetch(job.url);
      if (result.status === 200) {
        const desc = extractJobadDescription(result.body);
        if (desc.length > 200) {
          descByUrl.set(job.url, desc);
          console.log(`[careerjet-jd] ${job.url}: ${desc.length} chars ✓`);
        } else {
          console.warn(`[careerjet-jd] ${job.url}: extracted only ${desc.length} chars`);
        }
      }
    } catch (err) {
      console.warn(`[careerjet-jd] ${job.url}: ${err instanceof Error ? err.message : err}`);
    }
    if (attempted < careerjetTargets.length) await sleep(JD_DELAY);
  }

  let merged = 0;
  const out = jobs.map((j) => {
    const full = descByUrl.get(j.url);
    if (full) { merged++; return { ...j, description: full }; }
    return j;
  });

  console.log(`[careerjet-jd] merged ${merged}/${targets.length} full descriptions`);
  return { jobs: out, costUsd: 0, merged, fetched: targets.length };
}
