/**
 * Adzuna JD Fetcher — Cheerio actor for JobTrackr
 *
 * Takes a list of adzuna.com.au job URLs (post-filter survivors from the
 * worker) and returns the full job description for each, scraped over an
 * Apify RESIDENTIAL AU proxy.
 *
 * Why residential (verified 2026-06-22):
 *   - Adzuna's /details/<id> page is plain static HTML — NO Cloudflare, NO
 *     JS challenge. A `<section class="adp-body">` carries the full ~1.4-8k
 *     char JD. So Cheerio is the right tool (no browser needed → cheap).
 *   - But Adzuna applies per-IP rate limiting. The Fly worker IP is
 *     currently banned with `Retry-After: 3600` (1 hour cooldown) after the
 *     enrichment burst. Residential dodges that — each request rotates IPs.
 *
 * Input/output contract:
 *   Input:  { urls: string[], maxUrls? }
 *   Output: { url, description, fetchedAt }
 */

import { Actor, log, Dataset } from "apify";
import { CheerioCrawler } from "crawlee";

interface Input {
  urls?:    string[];
  maxUrls?: number;
}

const DEFAULT_MAX_URLS = 50;

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Adzuna URLs are either /land/ad/<id>?se=… or /details/<id>. Normalize to
 *  /details/<id> for consistency (the form that always returns the JD). */
function normalizeAdzunaUrl(raw: string): string | null {
  const m = raw.match(/\/(?:land\/ad|details)\/(\d+)/);
  if (!m) return null;
  return `https://www.adzuna.com.au/details/${m[1]}`;
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
  const targets: string[] = [];
  for (const raw of (Array.isArray(input.urls) ? input.urls : [])) {
    if (typeof raw !== "string") continue;
    const norm = normalizeAdzunaUrl(raw);
    if (norm && !targets.includes(norm)) targets.push(norm);
    if (targets.length >= maxUrls) break;
  }

  if (targets.length === 0) {
    log.error("No valid adzuna.com.au URLs provided.");
    await Actor.exit();
    return;
  }

  log.info(`[adzuna-jd] start — ${targets.length} URLs over residential AU proxy`);

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
    requestHandlerTimeoutSecs: 30,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxUsageCount: 20 } },
    async requestHandler({ $, request, body, response }) {
      // Adzuna's full JD lives in <section class="adp-body">. We also try a
      // couple of historical selectors as a defensive fallback — Adzuna has
      // rotated class names before.
      let desc = cleanText($("section.adp-body").text());
      if (desc.length < 500) {
        const alt = cleanText($("[data-aut-id='jobDescription'], .job-description, article").first().text());
        if (alt.length > desc.length) desc = alt;
      }
      if (desc.length > 500) {
        await Dataset.pushData({ url: request.url, description: desc, fetchedAt: new Date().toISOString() });
        ok++;
        log.info(`[adzuna-jd] ${request.url}: ${desc.length} chars ✓`);
        return;
      }
      thin++;
      const raw = (typeof body === "string" ? body : body?.toString("utf-8")) ?? "";
      const status = response?.statusCode ?? 0;
      const title = cleanText($("title").text());
      log.warning(
        `[adzuna-jd] ${request.url}: only ${desc.length} chars ` +
        `| HTTP=${status} | title="${title}" | bodyLen=${raw.length} | adpBodyNodes=${$("section.adp-body").length}`,
      );
    },
    failedRequestHandler({ request }, err) {
      log.warning(`[adzuna-jd] ${request.url} failed: ${err instanceof Error ? err.message : err}`);
    },
  });

  await crawler.run(targets.map((u) => ({ url: u })));

  log.info(`[adzuna-jd] done — ${ok} full descriptions, ${thin} thin/failed of ${targets.length}`);
  await Actor.exit();
}

main().catch((err) => {
  log.error("Fatal error", { err });
  process.exit(1);
});
