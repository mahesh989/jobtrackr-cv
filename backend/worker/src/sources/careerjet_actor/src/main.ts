/**
 * Careerjet JD Fetcher — Playwright actor for JobTrackr
 *
 * Takes a list of careerjet.com.au job URLs (post-filter survivors from the
 * worker) and returns the full job description for each, rendered with a real
 * Chromium browser over an Apify RESIDENTIAL AU proxy.
 *
 * Why Playwright + residential (verified 2026-06-22):
 *   - Datacenter IP: Cloudflare Turnstile hard-blocks every navigation (timeout).
 *   - Residential IP + Cheerio: Cloudflare serves an interstitial ("unusual
 *     traffic… verification required") because Cheerio executes no JS, so the
 *     challenge can't resolve → 0-char extraction.
 *   - Residential IP + real browser: Cloudflare's "managed challenge" auto-
 *     resolves silently (residential reputation + real-browser integrity
 *     together pass the check), and we get the full page.
 *
 * Input/output contract is identical to the Cheerio version:
 *   Input:  { urls: string[], maxUrls? }
 *   Output: { url, description, fetchedAt }
 */

import { Actor, log, Dataset } from "apify";
import { PlaywrightCrawler } from "crawlee";

interface Input {
  urls?:    string[];
  maxUrls?: number;
}

const DEFAULT_MAX_URLS    = 25;
const PAGE_TIMEOUT_MS     = 45_000;
const SELECTOR_TIMEOUT_MS = 25_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
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

  log.info(`[careerjet-jd] start — ${targets.length} URLs (Playwright + residential AU)`);

  // RESIDENTIAL AU proxy — datacenter is Turnstile-blocked, plain residential
  // gets an interstitial Cheerio can't solve. A real browser on residential
  // lets Cloudflare's managed challenge auto-resolve.
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ["RESIDENTIAL"],
    countryCode: "AU",
  });
  if (!proxyConfiguration) {
    log.error("No proxy configuration — RESIDENTIAL proxy is required (check your Apify plan).");
    await Actor.exit();
    return;
  }

  let ok = 0;
  let thin = 0;
  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 2,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 90,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxUsageCount: 20 } },
    headless: true,
    launchContext: {
      launchOptions: {
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
      },
    },
    browserPoolOptions: {
      useFingerprints: true,
    },
    preNavigationHooks: [
      async ({ page }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        });
      },
    ],
    async requestHandler({ page, request }) {
      // Land on the page. Cloudflare's managed challenge usually auto-resolves
      // within a couple of seconds when a real residential-IP browser is used.
      try {
        await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      } catch (err) {
        thin++;
        log.warning(`[careerjet-jd] ${request.url} goto failed: ${err instanceof Error ? err.message : err}`);
        return;
      }

      // Wait for the description container. If a challenge interstitial is up,
      // the wait window gives it time to auto-resolve and render the real page.
      let descAppeared = false;
      try {
        await page.waitForSelector("section.content", { timeout: SELECTOR_TIMEOUT_MS });
        descAppeared = true;
      } catch { /* fall through to diagnostics */ }

      if (descAppeared) {
        const text = await page.evaluate(() => {
          const el = document.querySelector("section.content");
          return el ? (el as HTMLElement).innerText : "";
        });
        const desc = cleanText(text);
        if (desc.length > 200) {
          await Dataset.pushData({ url: request.url, description: desc, fetchedAt: new Date().toISOString() });
          ok++;
          log.info(`[careerjet-jd] ${request.url}: ${desc.length} chars ✓`);
          return;
        }
        // Selector matched but content thin — fall through to diagnostics.
      }

      // Diagnostics on failure: what did the residential browser actually see?
      thin++;
      const diag = await page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        const body = document.body ? (document.body as HTMLElement).innerText : "";
        return {
          title:       document.title,
          bodyLen:     html.length,
          contentNodes: document.querySelectorAll("section.content").length,
          blocked: /turnstile|just a moment|cf-challenge|verify you are human|attention required|unusual traffic|verification required/i.test(html),
          snippet: body.replace(/\s+/g, " ").trim().slice(0, 200),
        };
      });
      log.warning(
        `[careerjet-jd] ${request.url}: thin extraction ` +
        `| title="${diag.title}" | bodyLen=${diag.bodyLen} | sectionContentNodes=${diag.contentNodes} ` +
        `| challengeMarkers=${diag.blocked} | snippet="${diag.snippet}"`,
      );
    },
    failedRequestHandler({ request }, err) {
      log.warning(`[careerjet-jd] ${request.url} failed: ${err instanceof Error ? err.message : err}`);
    },
  });

  await crawler.run(targets.map((u) => ({ url: u, headers: { "User-Agent": USER_AGENT } })));

  log.info(`[careerjet-jd] done — ${ok} full descriptions, ${thin} thin/failed of ${targets.length}`);
  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
