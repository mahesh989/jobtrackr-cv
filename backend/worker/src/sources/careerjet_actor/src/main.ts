/**
 * Careerjet JD Fetcher — Playwright actor for JobTrackr
 *
 * Mirrors seek_jd's pattern (manual browser/context, homepage warm-up, single
 * reused session) to make the residential AU IP look like one human browsing
 * Careerjet. PlaywrightCrawler was too aggressive — each request rotated
 * sessions before Cloudflare's managed challenge could auto-resolve.
 *
 * Verified 2026-06-22:
 *   - Datacenter IP: hard timeout on every nav (Turnstile).
 *   - Residential + Cheerio: 200 OK but a "Verification required" interstitial
 *     (no JS execution → challenge never resolves).
 *   - Residential + Playwright (Crawlee, no warm-up): same interstitial — the
 *     managed challenge needs >25s and/or prior session cookies to clear.
 *
 * This version:
 *   - Manually launches Chromium routed through an Apify RESIDENTIAL AU IP.
 *   - Warm-up: visits careerjet.com.au homepage first to pick up a clearance
 *     cookie (the home page isn't Turnstile-gated).
 *   - Then reuses ONE context for all JD fetches so the cookie persists.
 *   - Random 5-10s pacing between JDs (humanized).
 *
 * Input/output contract unchanged:
 *   Input:  { urls: string[], maxUrls? }
 *   Output: { url, description, fetchedAt }
 */

import { Actor, log, Dataset } from "apify";
import { chromium, type Browser, type BrowserContext } from "playwright";

interface Input {
  urls?:    string[];
  maxUrls?: number;
}

interface JdRow {
  url:         string;
  description: string;
  fetchedAt:   string;
}

const DEFAULT_MAX_URLS    = 25;
const PAGE_TIMEOUT_MS     = 60_000;
const SELECTOR_TIMEOUT_MS = 45_000;   // give the CF managed challenge time to clear

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

async function fetchOne(context: BrowserContext, url: string): Promise<JdRow | null> {
  const page = await context.newPage();
  try {
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      status = resp?.status() ?? 0;
    } catch (err) {
      log.warning(`[careerjet-jd] ${url} goto failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    if (status !== 200) {
      log.warning(`[careerjet-jd] ${url} HTTP ${status}`);
      return null;
    }

    // Wait for the description container. If Cloudflare is currently challenging
    // this IP, the wait window gives it time to auto-resolve and render the
    // real page. 45s is long, but managed-challenge resolution can need it.
    let descAppeared = false;
    try {
      await page.waitForSelector("section.content", { timeout: SELECTOR_TIMEOUT_MS });
      descAppeared = true;
    } catch { /* fall through to diagnostics */ }

    if (descAppeared) {
      // Half-page scroll then small jitter — looks human, also forces lazy nodes.
      await page.evaluate(() => {
        const y = Math.floor(document.body.scrollHeight * 0.45);
        window.scrollTo({ top: y, behavior: "smooth" });
      });
      await page.waitForTimeout(randInt(800, 1600));

      const text = await page.evaluate(() => {
        const el = document.querySelector("section.content");
        return el ? (el as HTMLElement).innerText : "";
      });
      const desc = cleanText(text);
      if (desc.length > 200) {
        log.info(`[careerjet-jd] ${url}: ${desc.length} chars ✓`);
        return { url, description: desc, fetchedAt: new Date().toISOString() };
      }
      // Selector matched but content thin — fall through to diagnostics.
    }

    // Diagnostics on failure
    const diag = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const body = document.body ? (document.body as HTMLElement).innerText : "";
      return {
        title:       document.title,
        bodyLen:     html.length,
        contentNodes: document.querySelectorAll("section.content").length,
        blocked: /turnstile|just a moment|cf-challenge|verify you are human|attention required|unusual traffic|verification required/i.test(html),
        snippet: body.replace(/\s+/g, " ").trim().slice(0, 220),
      };
    });
    log.warning(
      `[careerjet-jd] ${url}: thin extraction ` +
      `| title="${diag.title}" | bodyLen=${diag.bodyLen} | sectionContentNodes=${diag.contentNodes} ` +
      `| challengeMarkers=${diag.blocked} | snippet="${diag.snippet}"`,
    );
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
    } catch { /* ignore */ }
  }
  if (!input) input = {};

  const maxUrls = input.maxUrls ?? DEFAULT_MAX_URLS;
  const targets = (Array.isArray(input.urls) ? input.urls : [])
    .filter((u) => typeof u === "string" && u.includes("careerjet.com.au"))
    .slice(0, maxUrls);

  if (targets.length === 0) {
    log.error("No careerjet.com.au URLs provided.");
    await Actor.exit();
    return;
  }

  log.info(`[careerjet-jd] start — ${targets.length} URLs (Playwright + residential AU, warm-up + sticky session)`);

  // Single residential session: sticky IP across all JD fetches in this run.
  // Apify proxy: passing the URL via `server` makes Chromium route all requests
  // through it; the URL encodes the group + session.
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ["RESIDENTIAL"],
    countryCode: "AU",
  });
  if (!proxyConfiguration) {
    log.error("No proxy configuration — RESIDENTIAL proxy is required (check your Apify plan).");
    await Actor.exit();
    return;
  }
  // Lock to one residential IP for the whole run by using a session id.
  const sessionId = `careerjet_${Date.now()}`;
  const proxyUrl = await proxyConfiguration.newUrl(sessionId);
  if (!proxyUrl) {
    log.error("proxyConfiguration.newUrl returned undefined — residential proxy not available.");
    await Actor.exit();
    return;
  }
  log.info(`[careerjet-jd] proxy URL acquired (session=${sessionId})`);

  const browser: Browser = await chromium.launch({
    headless: true,
    proxy: { server: proxyUrl },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const context = await browser.newContext({
    userAgent:  USER_AGENT,
    viewport:   { width: 1366, height: 768 },
    locale:     "en-AU",
    timezoneId: "Australia/Sydney",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Warm up: hit Careerjet homepage first. It isn't behind the challenge, so
  // Chromium picks up Cloudflare's clearance cookie which then carries to /jobad.
  try {
    const warmup = await context.newPage();
    await warmup.goto("https://www.careerjet.com.au/", { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await warmup.waitForTimeout(randInt(2000, 4000));
    await warmup.close();
    log.info("[careerjet-jd] warm-up complete");
  } catch (err) {
    log.warning(`[careerjet-jd] warm-up failed (continuing): ${err instanceof Error ? err.message : err}`);
  }

  let ok = 0;
  let thin = 0;
  for (const [i, url] of targets.entries()) {
    log.info(`[careerjet-jd] ${i + 1}/${targets.length} → ${url}`);
    const row = await fetchOne(context, url);
    if (row) {
      await Dataset.pushData(row);
      ok++;
    } else {
      thin++;
    }
    if (i < targets.length - 1) {
      const wait = randInt(5_000, 10_000);
      log.info(`[careerjet-jd] waiting ${wait}ms before next`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  await context.close();
  await browser.close();

  log.info(`[careerjet-jd] done — ${ok} full descriptions, ${thin} thin/failed of ${targets.length}`);
  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
