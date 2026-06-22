/**
 * Careerjet AU Scraper — Cheerio actor for JobTrackr
 *
 * Why this exists: careerjet.com.au serves a Cloudflare Turnstile challenge to
 * datacenter IPs (so the Fly worker's curl_cffi scrape gets 0 jobs), while a
 * residential IP gets the real HTML with no challenge at all. So we run the
 * same cheerio parse here, on Apify, over an internal RESIDENTIAL AU proxy.
 * No browser is needed — the residential IP alone clears Turnstile.
 *
 * Two phases in one run (the IP is already trusted after phase 1):
 *   LISTING — careerjet.com.au/search → parse `article.job` cards
 *   JOBAD   — careerjet.com.au/jobad/<hash> → full description (section.content)
 *
 * Input:  { keywords: string[], location?, maxResults?, maxPages?, fetchJDs?, jdCap? }
 * Output: { title, company, location, salary, url, description, keyword }
 *         description = full JD when fetched, else the listing teaser.
 */

import { Actor, log, Dataset } from "apify";
import { CheerioCrawler, createCheerioRouter } from "crawlee";

interface Input {
  keywords?:   string[];
  query?:      string;   // legacy single-keyword alias
  location?:   string;
  maxResults?: number;
  maxPages?:   number;
  fetchJDs?:   boolean;
  jdCap?:      number;
}

interface JobRow {
  title:       string;
  company:     string;
  location:    string;
  salary:      string;
  url:         string;       // https://www.careerjet.com.au/jobad/<hash>
  description: string;       // full JD if fetched, else teaser
  keyword:     string;
}

const BASE = "https://www.careerjet.com.au";

// Accumulators shared across handlers within this single run.
const jobsByUrl = new Map<string, JobRow>();
const perKeywordCount = new Map<string, number>();
let jdFetched = 0;

function apiLocation(loc: string): string {
  const t = (loc ?? "").trim();
  const low = t.toLowerCase();
  if (!t || low === "australia" || low === "all australia") return "";
  return t;
}

function searchUrl(keyword: string, location: string, page: number): string {
  const params = new URLSearchParams({ s: keyword, l: location, p: String(page) });
  return `${BASE}/search/jobs?${params.toString()}`;
}

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

const router = createCheerioRouter();

router.addHandler("LISTING", async ({ $, request, crawler }) => {
  const { keyword, location, maxPerKeyword, maxPages, fetchJDs, jdCap, pageNum } =
    request.userData as {
      keyword: string; location: string; maxPerKeyword: number; maxPages: number;
      fetchJDs: boolean; jdCap: number; pageNum: number;
    };

  const articles = $("article.job");
  if (articles.length === 0) {
    const title = $("title").text().trim();
    log.warning(`[careerjet] "${keyword}" page ${pageNum}: 0 article.job (title: "${title}")`);
    return;
  }

  let pageAdded = 0;
  const jdUrls: string[] = [];
  articles.each((_, el) => {
    const $el = $(el);
    const $a = $el.find("header h2 a");
    const title = cleanText($a.text());
    const href = $a.attr("href");
    if (!title || !href) return;

    const url = href.startsWith("http") ? href : `${BASE}${href}`;
    const baseUrl = url.split("?")[0];
    if (jobsByUrl.has(baseUrl)) return;

    const count = perKeywordCount.get(keyword) ?? 0;
    if (count >= maxPerKeyword) return;

    const company = cleanText($el.find("p.company").text());
    let locText = "";
    $el.find("ul.location li").each((__, li) => { locText += $(li).text().trim() + " "; });
    locText = cleanText(locText) || location;
    const salary = cleanText($el.find("ul.salary").text());
    const teaser = cleanText($el.find("div.desc").text());

    jobsByUrl.set(baseUrl, { title, company, location: locText, salary, url: baseUrl, description: teaser, keyword });
    perKeywordCount.set(keyword, count + 1);
    pageAdded++;

    // Mark for full-JD enrichment (best-effort, capped). Enqueued (awaited)
    // after the loop so we never race crawler completion.
    if (fetchJDs && jdFetched < jdCap) {
      jdFetched++;
      jdUrls.push(baseUrl);
    }
  });

  log.info(`[careerjet] "${keyword}" page ${pageNum}/${maxPages}: +${pageAdded} (kw total ${perKeywordCount.get(keyword) ?? 0})`);

  if (jdUrls.length > 0) {
    await crawler.addRequests(jdUrls.map((u) => ({ url: u, label: "JOBAD", userData: { jobUrl: u } })));
  }

  // Pagination: stop at the cap, the page limit, or a short final page.
  const kwTotal = perKeywordCount.get(keyword) ?? 0;
  if (kwTotal < maxPerKeyword && pageNum < maxPages && articles.length >= 10) {
    await crawler.addRequests([{
      url: searchUrl(keyword, location, pageNum + 1),
      label: "LISTING",
      userData: { keyword, location, maxPerKeyword, maxPages, fetchJDs, jdCap, pageNum: pageNum + 1 },
    }]);
  }
});

router.addHandler("JOBAD", async ({ $, request }) => {
  const { jobUrl } = request.userData as { jobUrl: string };
  const desc = cleanText($("section.content").text());
  const row = jobsByUrl.get(jobUrl);
  if (row && desc.length > 200) {
    row.description = desc;
    log.info(`[careerjet-jd] ${jobUrl}: ${desc.length} chars ✓`);
  } else if (row) {
    log.warning(`[careerjet-jd] ${jobUrl}: only ${desc.length} chars — keeping teaser`);
  }
});

async function main(): Promise<void> {
  await Actor.init();

  let input = await Actor.getInput<Input>();
  if (!input && process.env.APIFY_INPUT_PATH) {
    try {
      const { readFileSync } = await import("fs");
      input = JSON.parse(readFileSync(process.env.APIFY_INPUT_PATH, "utf-8"));
    } catch { /* ignore */ }
  }
  if (!input) input = { keywords: ["assistant in nursing"], location: "Sydney NSW" };

  const keywords = input.keywords && input.keywords.length > 0
    ? input.keywords
    : (input.query ? [input.query] : []);
  const location   = apiLocation(input.location ?? "All Australia");
  const maxResults = input.maxResults ?? 200;
  const maxPages   = input.maxPages   ?? 6;
  const fetchJDs   = input.fetchJDs   ?? true;
  const jdCap      = input.jdCap      ?? 40;

  if (keywords.length === 0) {
    log.error("No keywords provided.");
    await Actor.exit();
    return;
  }

  const maxPerKeyword = Math.ceil(maxResults / keywords.length);
  log.info(`[careerjet] start — keywords=${keywords.join(", ")} location="${location || "(AU-wide)"}" maxResults=${maxResults} fetchJDs=${fetchJDs}`);

  // Internal RESIDENTIAL AU proxy — clears Turnstile (datacenter-only block).
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ["RESIDENTIAL"],
    countryCode: "AU",
  });
  if (!proxyConfiguration) {
    log.error("No proxy configuration — RESIDENTIAL proxy is required (check your Apify plan).");
    await Actor.exit();
    return;
  }

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: 4,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 45,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxUsageCount: 20 } },
  });

  const startRequests = keywords
    .filter((k) => k && k.trim())
    .map((k) => ({
      url: searchUrl(k.trim(), location, 1),
      label: "LISTING",
      userData: { keyword: k.trim(), location, maxPerKeyword, maxPages, fetchJDs, jdCap, pageNum: 1 },
    }));

  await crawler.run(startRequests);

  const rows = [...jobsByUrl.values()];
  await Dataset.pushData(rows);
  const withFullJd = rows.filter((r) => r.description.length > 250).length;
  log.info(`[careerjet] done — ${rows.length} jobs (${withFullJd} with full JD)`);

  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
