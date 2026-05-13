/**
 * SEEK JD Fetcher — Playwright actor for JobTrackr
 *
 * Takes a list of SEEK job detail URLs and extracts the full job description
 * from each via a single, humanized Playwright session.
 *
 * Design choices:
 * - One browser context reused across all URLs → cookies/fingerprint stay
 *   consistent, looks like one human reading multiple listings.
 * - URLs shuffled before fetch → avoids sequential-ID detection.
 * - Random 6-12s wait + half-page scroll between fetches.
 * - Hard cap on URL count (worker should already cap to ≤20, this is belt+braces).
 *
 * Input:  { urls: string[], maxUrls?: number, minDelayMs?: number, maxDelayMs?: number }
 * Output: { url, jobId, description, descriptionHtml?, fetchedAt }
 */

import { Actor, log } from "apify";
import { chromium, type Browser, type BrowserContext } from "playwright";

interface Input {
  urls?:        string[];
  maxUrls?:     number;
  minDelayMs?:  number;
  maxDelayMs?:  number;
  includeHtml?: boolean;
}

interface JdRow {
  url:             string;
  jobId:           string;
  description:     string;
  descriptionHtml: string | null;
  fetchedAt:       string;
}

const DEFAULT_MAX_URLS    = 25;
const DEFAULT_MIN_DELAY   = 6_000;
const DEFAULT_MAX_DELAY   = 12_000;
const PAGE_TIMEOUT_MS     = 30_000;
const SELECTOR_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function extractJobId(url: string): string {
  const m = url.match(/\/job\/(\d+)/);
  return m ? m[1] : "";
}

async function fetchOne(
  context:     BrowserContext,
  url:         string,
  includeHtml: boolean
): Promise<JdRow | null> {
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout:   PAGE_TIMEOUT_MS,
    });
    const status = resp?.status() ?? 0;
    if (status !== 200) {
      log.warning(`[jd] ${url} HTTP ${status}`);
      return null;
    }

    // Wait for SEEK's React to mount the description container
    try {
      await page.waitForSelector(
        '[data-automation="jobAdDetails"], [data-automation="jobDescription"]',
        { timeout: SELECTOR_TIMEOUT_MS }
      );
    } catch {
      log.warning(`[jd] ${url} description container did not appear`);
      return null;
    }

    // Humanize: scroll halfway down (real readers don't insta-extract)
    await page.evaluate(() => {
      const targetY = Math.floor(document.body.scrollHeight * 0.45);
      window.scrollTo({ top: targetY, behavior: "smooth" });
    });
    await page.waitForTimeout(randInt(800, 1600));

    const { text, html } = await page.evaluate((wantHtml) => {
      const el =
        document.querySelector('[data-automation="jobAdDetails"]') ||
        document.querySelector('[data-automation="jobDescription"]');
      if (!el) return { text: "", html: "" };
      return {
        text: (el as HTMLElement).innerText.trim(),
        html: wantHtml ? el.innerHTML : "",
      };
    }, includeHtml);

    if (!text) {
      log.warning(`[jd] ${url} extracted empty text`);
      return null;
    }

    return {
      url,
      jobId:           extractJobId(url),
      description:     text,
      descriptionHtml: includeHtml ? html : null,
      fetchedAt:       new Date().toISOString(),
    };
  } catch (err) {
    log.warning(`[jd] ${url} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

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
  if (!input) input = {};

  const rawUrls = Array.isArray(input.urls) ? input.urls : [];
  const maxUrls    = input.maxUrls    ?? DEFAULT_MAX_URLS;
  const minDelayMs = input.minDelayMs ?? DEFAULT_MIN_DELAY;
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_MAX_DELAY;
  const includeHtml = input.includeHtml ?? false;

  const cleanUrls = rawUrls
    .filter((u) => typeof u === "string" && /^https:\/\/www\.seek\.com\.au\/job\/\d+/.test(u))
    .slice(0, maxUrls);

  if (cleanUrls.length === 0) {
    log.error("No valid SEEK job URLs provided.");
    await Actor.exit();
    return;
  }

  log.info(`[jd] starting — ${cleanUrls.length} URLs, delay ${minDelayMs}-${maxDelayMs}ms`);

  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport:  { width: 1366, height: 768 },
    locale:    "en-AU",
    timezoneId: "Australia/Sydney",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Warm up: hit SEEK homepage first to pick up cookies / look like a real visit
  try {
    const warmup = await context.newPage();
    await warmup.goto("https://www.seek.com.au/", {
      waitUntil: "domcontentloaded",
      timeout:   PAGE_TIMEOUT_MS,
    });
    await warmup.waitForTimeout(randInt(1500, 3000));
    await warmup.close();
    log.info("[jd] warmup complete");
  } catch (err) {
    log.warning(`[jd] warmup failed (continuing): ${err instanceof Error ? err.message : err}`);
  }

  // Shuffle to avoid sequential-ID traversal pattern
  const order = shuffle(cleanUrls);

  let ok = 0;
  let fail = 0;
  for (const [i, url] of order.entries()) {
    log.info(`[jd] ${i + 1}/${order.length} → ${url}`);
    const row = await fetchOne(context, url, includeHtml);
    if (row) {
      await Actor.pushData(row);
      ok++;
    } else {
      fail++;
    }

    if (i < order.length - 1) {
      const wait = randInt(minDelayMs, maxDelayMs);
      log.info(`[jd] waiting ${wait}ms before next`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  await context.close();
  await browser.close();

  log.info(`[jd] done — ${ok} fetched, ${fail} failed`);
  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
