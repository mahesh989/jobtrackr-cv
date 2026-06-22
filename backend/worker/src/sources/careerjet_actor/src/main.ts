/**
 * Careerjet JD Fetcher — Cheerio actor for JobTrackr
 *
 * Takes a list of careerjet.com.au job URLs (post-filter survivors from the
 * worker) and returns the full job description for each, scraped over an
 * Apify RESIDENTIAL AU proxy.
 *
 * Why this exists: careerjet.com.au is behind Cloudflare Turnstile, which
 * hard-blocks datacenter IPs even for a real browser (verified — Apify
 * datacenter Playwright runs time out on every navigation). A RESIDENTIAL IP
 * gets the page with no challenge at all, so a plain Cheerio fetch works —
 * no browser needed, minimal compute.
 *
 * This is the "narrow + expensive" half of the funnel (mirrors seek-jd-fetcher):
 *   - listings come FREE from the Careerjet v4 API (in the worker)
 *   - the worker filters/dedups to ~20 survivors
 *   - this actor fetches full JDs for only those survivors → residential cost
 *     is paid for the handful that matter, not all listings.
 *
 * Input:  { urls: string[], maxUrls? }
 * Output: { url, description, fetchedAt }
 */

import { Actor, log, Dataset } from "apify";
import { CheerioCrawler } from "crawlee";

interface Input {
  urls?:    string[];
  maxUrls?: number;
}

const DEFAULT_MAX_URLS = 25;

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

  log.info(`[careerjet-jd] start — ${targets.length} URLs over residential proxy`);

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

  let ok = 0;
  let thin = 0;
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 4,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 45,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxUsageCount: 20 } },
    async requestHandler({ $, request, body }) {
      // CheerioCrawler follows redirects, so a /clk or /jobad URL both land on
      // the canonical job-ad page. The full description lives in section.content.
      const desc = cleanText($("section.content").text());
      if (desc.length > 200) {
        await Dataset.pushData({ url: request.url, description: desc, fetchedAt: new Date().toISOString() });
        ok++;
        log.info(`[careerjet-jd] ${request.url}: ${desc.length} chars ✓`);
      } else {
        thin++;
        // Diagnostics: what did this IP actually receive? (challenge vs real page)
        const raw = (typeof body === "string" ? body : body?.toString("utf-8")) ?? "";
        const title = cleanText($("title").text());
        const blocked = /turnstile|just a moment|cf-challenge|verify you are human|attention required|enable javascript/i.test(raw);
        log.warning(
          `[careerjet-jd] ${request.url}: only ${desc.length} chars ` +
          `| title="${title}" | bodyLen=${raw.length} | sectionContentNodes=${$("section.content").length} ` +
          `| challengeMarkers=${blocked} | snippet="${cleanText($("body").text()).slice(0, 160)}"`,
        );
      }
    },
    failedRequestHandler({ request }, err) {
      log.warning(`[careerjet-jd] ${request.url} failed: ${err instanceof Error ? err.message : err}`);
    },
  });

  await crawler.run(targets.map((u) => ({ url: u })));

  log.info(`[careerjet-jd] done — ${ok} full descriptions, ${thin} thin/failed of ${targets.length}`);
  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
