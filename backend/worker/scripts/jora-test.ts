/**
 * Jora scraper — standalone test script
 *
 * Run:
 *   npx ts-node --esm src/sources/jora-test.ts
 *
 * Key optimisation: route blocking — images, CSS, fonts, media are aborted
 * before download. Cuts memory ~70% and makes pages load 3-5x faster.
 * Jora is fully JS-rendered so we need a real browser, but we only need
 * the DOM text — everything visual is wasted bandwidth.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// ── Config ────────────────────────────────────────────────────────────────────

const KEYWORDS = ["data analyst", "business analyst"];
const LOCATION = "Sydney";
const DAYS_BACK = 14;
const MAX_PAGES = 3;
const HEADLESS = true;   // flip to false to watch the browser

// Delay range between pages (ms) — keeps request cadence human-like
const PAGE_DELAY_MIN = 2_500;
const PAGE_DELAY_MAX = 4_500;

// Resource types to block — we only need HTML + JS to render the DOM
const BLOCK_TYPES = new Set([
  "image", "stylesheet", "font", "media",
  "ping", "manifest", "other",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface JoraJob {
  title: string;
  company: string;
  location: string;
  posted_date: string;
  salary: string;
  snippet: string;
  url: string;
  keyword: string;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseJoraDate(raw: string): Date | null {
  const s = raw.toLowerCase().replace(/^posted\s+/, "").trim();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  if (s.includes("today")) return today;
  if (s.includes("yesterday")) { const d = new Date(today); d.setDate(d.getDate() - 1); return d; }

  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d+)\s*h(?:our)?s?\s*(ago)?/)))              return today;                                                                       // "1h ago", "18h ago"
  if ((m = s.match(/(\d+)\s*d(?:ay)?s?\s*ago/)))                  { const d = new Date(today); d.setDate(d.getDate() - +m[1]); return d; }            // "2d ago", "22d ago", "4 days ago"
  if ((m = s.match(/(\d+)\s*w(?:eek)?s?\s*ago/)))                 { const d = new Date(today); d.setDate(d.getDate() - +m[1] * 7); return d; }        // "2w ago", "2 weeks ago"
  if ((m = s.match(/(\d+)\s*mo(?:nth)?s?\s*ago|(\d+)\s*month/))) { const d = new Date(today); d.setDate(d.getDate() - +(m[1]??m[2]) * 30); return d; } // "3mo ago", "3 months ago"

  return null;
}

function isWithinCutoff(raw: string, cutoff: Date): boolean {
  const d = parseJoraDate(raw);
  return d === null || d >= cutoff;  // keep if date unparseable
}

// ── Browser setup ─────────────────────────────────────────────────────────────

async function makeBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-web-security",
      "--window-size=1280,800",
    ],
  });
}

async function makeContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
  });

  // Anti-detection: hide webdriver flag
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-AU", "en"] });
    (window as any).chrome = { runtime: {} };
  });

  return ctx;
}

async function makePage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();

  // ── ROUTE BLOCKING — the key resource-saving trick ───────────────────────
  // Abort images, CSS, fonts etc. before they are downloaded.
  // We only need HTML + JS for the DOM to render.
  await page.route("**/*", (route) => {
    if (BLOCK_TYPES.has(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return page;
}

// ── Scraping ──────────────────────────────────────────────────────────────────

function delay(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

// Returns jobs found on the page. Returns [] if the page has no cards (signals end).
async function scrapePage(
  page: Page,
  keyword: string,
  pageNum: number,
  cutoff: Date,
): Promise<JoraJob[]> {
  const url = `https://au.jora.com/j?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(LOCATION)}&p=${pageNum}`;
  console.log(`  [${keyword}] page ${pageNum} → ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });

  // Wait for job cards — 15s to handle slow loads; return [] to signal end-of-results
  try {
    await page.waitForSelector(
      "article[data-automation='job'], [data-automation='jobCard'], article, .job-card",
      { timeout: 15_000 }
    );
  } catch {
    console.warn(`  [${keyword}] page ${pageNum}: no cards — end of results`);
    return [];
  }

  // Scroll to trigger any lazy-loaded cards
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await delay(800, 1_500);

  // All browser-side code as a raw string — avoids esbuild __name injection
  const raw = await page.evaluate(`(function() {
    var selectors = [
      "[data-automation='jobCard']",
      "article[class*='job']",
      "article",
      ".job-card"
    ];
    var cards = [];
    for (var i = 0; i < selectors.length; i++) {
      cards = Array.from(document.querySelectorAll(selectors[i]));
      if (cards.length > 0) break;
    }

    return cards.map(function(card) {
      function text(sel) {
        var el = card.querySelector(sel);
        return el ? (el.textContent || "").trim() : "";
      }
      function href(sel) {
        var el = card.querySelector(sel);
        return el ? (el.href || "") : "";
      }
      return {
        title:       text("a[href*='/j/'], h2 a, h3 a, [data-automation='jobTitle']"),
        url:         href("a[href*='/j/'], h2 a, h3 a, [data-automation='jobTitle']"),
        company:     text("[data-automation='jobCompany'], [class*='company']"),
        location:    text("[data-automation='jobLocation'], [class*='location']"),
        posted_date: text("[data-automation='jobListingDate'], [class*='date'], [class*='posted']"),
        salary:      text("[data-automation='jobSalary'], [class*='salary']"),
        snippet:     text("[data-automation='jobSnippet'], [class*='snippet'], [class*='description']")
      };
    });
  })()`) as Array<{
    title: string; url: string; company: string; location: string;
    posted_date: string; salary: string; snippet: string;
  }>;

  if (raw.length === 0) return [];   // no cards extracted → stop paging

  const jobs: JoraJob[] = raw
    .filter((r) => r.title && r.url)
    .filter((r) => isWithinCutoff(r.posted_date, cutoff))
    .map((r) => ({
      title: r.title,
      company: r.company,
      location: r.location || LOCATION,
      posted_date: r.posted_date,
      salary: r.salary,
      snippet: r.snippet.slice(0, 400),
      url: r.url,
      keyword,
    }));

  console.log(`  [${keyword}] page ${pageNum}: ${raw.length} cards → ${jobs.length} kept`);
  return jobs;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

function deduplicate(jobs: JoraJob[]): JoraJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    const key = `${j.title.toLowerCase()}|${j.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_BACK);
  cutoff.setHours(0, 0, 0, 0);

  console.log("=".repeat(60));
  console.log("JORA SCRAPER — standalone test");
  console.log(`Keywords : ${KEYWORDS.join(", ")}`);
  console.log(`Location : ${LOCATION}`);
  console.log(`Days back: ${DAYS_BACK}  (cutoff ${cutoff.toDateString()})`);
  console.log(`Max pages: ${MAX_PAGES}`);
  console.log(`Headless : ${HEADLESS}`);
  console.log("Route blocking: images/CSS/fonts/media blocked ← resource saver");
  console.log("=".repeat(60));

  const browser = await makeBrowser();
  const ctx = await makeContext(browser);
  const page = await makePage(ctx);
  const allJobs: JoraJob[] = [];

  try {
    for (const keyword of KEYWORDS) {
      console.log(`\nKeyword: "${keyword}"`);

      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const jobs = await scrapePage(page, keyword, pageNum, cutoff);

        if (jobs.length === 0) {
          console.log(`  [${keyword}] no results on page ${pageNum} — stopping`);
          break;
        }

        allJobs.push(...jobs);

        // If we got a full page, there's likely a next page — keep going
        // Inter-page delay to stay human-paced
        if (pageNum < MAX_PAGES) {
          await delay(PAGE_DELAY_MIN, PAGE_DELAY_MAX);
        }
      }

      // Delay between keywords
      if (KEYWORDS.indexOf(keyword) < KEYWORDS.length - 1) {
        await delay(3_000, 6_000);
      }
    }
  } finally {
    await browser.close();
  }

  const unique = deduplicate(allJobs);

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${unique.length} unique jobs (${allJobs.length} before dedup)`);
  console.log("=".repeat(60));

  if (unique.length === 0) {
    console.log("No jobs found. Try:");
    console.log("  1. Set HEADLESS = false to watch the browser");
    console.log("  2. Check if Jora is blocking — run a single keyword manually");
    return;
  }

  // Print table
  console.log(
    "\n" +
    ["Title", "Company", "Location", "Posted", "Keyword"]
      .map((h) => h.padEnd(28))
      .join(" | ")
  );
  console.log("-".repeat(140));
  for (const j of unique.slice(0, 30)) {
    console.log(
      [j.title, j.company, j.location, j.posted_date, j.keyword]
        .map((v) => (v ?? "").slice(0, 27).padEnd(28))
        .join(" | ")
    );
  }
  if (unique.length > 30) console.log(`  … and ${unique.length - 30} more`);

  // Keyword summary
  console.log("\nBy keyword:");
  for (const kw of KEYWORDS) {
    console.log(`  "${kw}": ${unique.filter((j) => j.keyword === kw).length} jobs`);
  }

  // JSON dump for inspection
  const fs = await import("fs");
  const out = `jora_test_${new Date().toISOString().slice(0, 16).replace(":", "-")}.json`;
  fs.writeFileSync(out, JSON.stringify(unique, null, 2));
  console.log(`\nSaved → ${out}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
