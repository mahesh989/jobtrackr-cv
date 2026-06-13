/**
 * SEEK AU Job Scraper — Playwright actor for JobTrackr
 *
 * Renders SEEK's React SPA with a real browser (Playwright/Chromium),
 * extracts job cards from the DOM. Bypasses anti-bot completely because
 * it IS a real browser — no GraphQL auth, no TLS fingerprinting needed.
 *
 * Input:  { keywords: string[], location?, dateRange?, maxResults? }
 *         (also accepts legacy { query: string } as a single-keyword alias)
 * Output: { id, title, company, location, area, salary, teaser,
 *           listingDate, url, workType, keyword }
 */

import { Actor, log, Dataset } from "apify";
import { PlaywrightCrawler, createPlaywrightRouter } from "crawlee";

interface Input {
  keywords?:   string[];
  query?:      string;   // legacy single-keyword alias
  location?:   string;
  dateRange?:  number;
  maxResults?: number;
}

interface JobRow {
  id:          string;
  title:       string;
  company:     string;
  location:    string;
  area:        string;
  salary:      string;
  teaser:      string;
  listingDate: string;
  url:         string;
  workType:    string;
  keyword:     string;
}

function cleanJobUrl(raw: string): string {
  if (!raw) return "";
  try {
    const full = raw.startsWith("http") ? raw : `https://www.seek.com.au${raw}`;
    const u = new URL(full);
    return `https://www.seek.com.au${u.pathname}`;
  } catch {
    return raw;
  }
}

function cleanJobId(raw: string): string {
  const m = raw.match(/(\d{7,9})/);
  return m ? m[1] : raw.split("?")[0].split("/").pop() ?? raw;
}

function buildSearchUrl(keyword: string, location: string, dateRange: number, page: number): string {
  const params = new URLSearchParams({
    keywords:  keyword,
    sortmode:  "ListedDate",
    page:      String(page),
  });

  if (dateRange && dateRange < 999) {
    params.set("daterange", String(dateRange));
  }

  const loc = location.trim().toLowerCase();
  if (loc && loc !== "australia" && loc !== "all australia") {
    params.set("where", location.trim());
  }

  return `https://www.seek.com.au/jobs?${params.toString()}`;
}

const router = createPlaywrightRouter();

router.addHandler("LISTING", async ({ page, request, crawler }) => {
  const { keyword, location, dateRange, maxPerKeyword, pageNum } = request.userData as {
    keyword:        string;
    location:       string;
    dateRange:      number;
    maxPerKeyword:  number;
    pageNum:        number;
  };

  log.info(`Processing page ${pageNum}: ${request.url}`);

  try {
    await page.waitForSelector(
      'article[data-testid="job-card"], article[data-automation="normalJob"], [data-automation="jobCard"]',
      { timeout: 20000 }
    );
  } catch {
    const title = await page.title();
    log.warning(`[${keyword}] Page ${pageNum}: No job cards found (title: "${title}").`);
    return;
  }

  const rawJobs = await page.evaluate(() => {
    const cards = document.querySelectorAll(
      'article[data-testid="job-card"], article[data-automation="normalJob"], [data-automation="jobCard"]'
    );

    return Array.from(cards).map((card) => {
      const titleEl =
        card.querySelector('a[data-automation="jobTitle"]') ||
        card.querySelector('a[data-testid="job-card-title"]') ||
        card.querySelector("h3 a");

      const href  = titleEl?.getAttribute("href") ?? "";
      const title = titleEl?.textContent?.trim() ?? "";

      const companyEl =
        card.querySelector('a[data-automation="jobCompany"]') ||
        card.querySelector('span[data-automation="jobCompany"]') ||
        card.querySelector('[data-testid="job-card-company"]') ||
        card.querySelector('[data-automation="advertiser-name"]');
      const company = companyEl?.textContent?.trim() ?? "";

      const locationEl =
        card.querySelector('span[data-automation="jobLocation"]') ||
        card.querySelector('a[data-automation="jobLocation"]') ||
        card.querySelector('[data-testid="job-card-location"]');
      const location = locationEl?.textContent?.trim() ?? "";

      const areaEl = card.querySelector('a[data-automation="jobArea"]') ||
        card.querySelector('[data-testid="job-card-suburb"]');
      const area = areaEl?.textContent?.trim() ?? "";

      const salaryEl =
        card.querySelector('span[data-automation="jobSalary"]') ||
        card.querySelector('[data-testid="job-card-salary"]');
      const salary = salaryEl?.textContent?.trim() ?? "";

      const workTypeEl =
        card.querySelector('span[data-automation="jobWorkType"]') ||
        card.querySelector('[data-testid="job-card-work-type"]');
      const workType = workTypeEl?.textContent?.trim() ?? "";

      const teaserEl =
        card.querySelector('[data-automation="jobShortDescription"]') ||
        card.querySelector('[data-testid="job-card-teaser"]') ||
        card.querySelector("p[class*='teaser'], p[class*='description']");
      const teaser = teaserEl?.textContent?.trim() ?? "";

      const dateEl =
        card.querySelector('span[data-automation="jobListingDate"]') ||
        card.querySelector('[data-testid="job-card-date"]') ||
        card.querySelector("time") ||
        card.querySelector('[data-automation="jobDate"]');
      const listingDate = dateEl?.textContent?.trim() ?? "";

      return { href, title, company, location, area, salary, workType, teaser, listingDate };
    });
  });

  const datasetItems = await Dataset.getData();
  const alreadySaved = datasetItems.items.filter(
    (item) => (item as JobRow).keyword === keyword
  ).length;

  const batch: JobRow[] = [];

  for (const raw of rawJobs) {
    if (!raw.href || !raw.title) continue;
    if (alreadySaved + batch.length >= maxPerKeyword) break;

    batch.push({
      id:          cleanJobId(raw.href),
      title:       raw.title,
      company:     raw.company,
      location:    raw.location,
      area:        raw.area,
      salary:      raw.salary,
      teaser:      raw.teaser,
      listingDate: raw.listingDate,
      url:         cleanJobUrl(raw.href),
      workType:    raw.workType,
      keyword,
    });
  }

  if (batch.length > 0) {
    await Dataset.pushData(batch);
    log.info(`Page ${pageNum}: Found ${batch.length} jobs`);
  } else {
    log.info(`Page ${pageNum}: no new jobs to save`);
  }

  if (alreadySaved + batch.length >= maxPerKeyword) {
    log.info(`[${keyword}] Reached cap of ${maxPerKeyword} — stopping`);
    return;
  }

  const nextHref = await page.evaluate(() => {
    const nextBtn =
      document.querySelector<HTMLAnchorElement>('a[data-automation="pagination-next"]') ||
      document.querySelector<HTMLAnchorElement>('a[aria-label="Next"]') ||
      document.querySelector<HTMLAnchorElement>('a[data-testid="pagination-next"]');
    if (nextBtn && !nextBtn.getAttribute("aria-disabled") && !nextBtn.getAttribute("disabled")) {
      return nextBtn.getAttribute("href") ?? null;
    }
    return null;
  });

  if (nextHref) {
    const nextUrl = nextHref.startsWith("http")
      ? nextHref
      : `https://www.seek.com.au${nextHref}`;

    await crawler.addRequests([{
      url:      nextUrl,
      userData: { label: "LISTING", keyword, location, dateRange, maxPerKeyword, pageNum: pageNum + 1 },
    }]);
  }
});

async function main(): Promise<void> {
  await Actor.init();

  let input = await Actor.getInput<Input>();

  if (!input && process.env.APIFY_INPUT_PATH) {
    try {
      const { readFileSync } = await import("fs");
      input = JSON.parse(readFileSync(process.env.APIFY_INPUT_PATH, "utf-8"));
      log.info("Loaded input from file");
    } catch {
      log.warning("Could not load input from file");
    }
  }

  if (!input) {
    input = { keywords: ["Data Analyst"], location: "All Australia", dateRange: 14, maxResults: 20 };
    log.info("Using default input", input);
  }

  // Accept either `keywords: string[]` or legacy `query: string`
  const keywords   = input.keywords && input.keywords.length > 0
    ? input.keywords
    : (input.query ? [input.query] : []);
  const location   = input.location  ?? "All Australia";
  const dateRange  = input.dateRange  ?? 14;
  const maxResults = input.maxResults ?? 200;

  if (keywords.length === 0) {
    log.error("No keywords provided — nothing to search.");
    await Actor.exit();
    return;
  }

  log.info(`Starting SEEK scraper`, { keywords, location, dateRange, maxResults });

  const maxPerKeyword = Math.ceil(maxResults / keywords.length);

  for (const keyword of keywords) {
    // Use a per-run unique queue name so Apify never dedupes against a prior run.
    // Named queues persist across runs on the cloud and would mark our URLs as
    // already-handled, leading to "0 requests processed" on identical reruns.
    const runId = process.env.APIFY_ACTOR_RUN_ID ?? Date.now().toString();
    const safe  = keyword.replace(/\W+/g, "-");
    const requestQueue = await Actor.openRequestQueue(`seek-${safe}-${runId}`);
    const firstUrl     = buildSearchUrl(keyword, location, dateRange, 1);

    await requestQueue.addRequest({
      url:      firstUrl,
      userData: { label: "LISTING", keyword, location, dateRange, maxPerKeyword, pageNum: 1 },
    });

    const crawler = new PlaywrightCrawler({
      requestQueue,
      requestHandler:           router,
      maxRequestsPerCrawl:      Math.ceil(maxPerKeyword / 22) + 2,
      maxConcurrency:           1,
      requestHandlerTimeoutSecs: 60,
      headless:                 true,
      useSessionPool:           true,
      sessionPoolOptions: {
        maxPoolSize: 3,
        sessionOptions: { maxAgeSecs: 300 },
      },
      launchContext: {
        launchOptions: {
          args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox",
          ],
        },
      },
      preNavigationHooks: [
        async ({ page }) => {
          await page.setViewportSize({ width: 1366, height: 768 });
          await page.addInitScript(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => undefined });
          });
        },
      ],
    });

    await crawler.run();
  }

  const dataset = await Dataset.getData();
  log.info(`✅ Scraping complete! Total jobs: ${dataset.items.length}`);

  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
