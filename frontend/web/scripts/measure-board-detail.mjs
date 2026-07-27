/**
 * Bulk-measures board detail pane open latency across N job cards.
 *
 * Two numbers per card:
 *   - networkMs:  click -> `/api/jobs/:id/board-detail` response received
 *   - paintMs:    click -> the tab bar for that job actually renders
 *                 (covers cache-hit cases where no network call happens)
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   LOGIN_EMAIL=you@example.com LOGIN_PASSWORD=... \
 *   CARD_COUNT=15 \
 *   node scripts/measure-board-detail.mjs
 *
 * Requires `playwright` installed (npm i -D playwright) and the dev server running.
 */
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.LOGIN_EMAIL;
const PASSWORD = process.env.LOGIN_PASSWORD;
const CARD_COUNT = Number(process.env.CARD_COUNT ?? 15);
const REPEAT = Number(process.env.REPEAT ?? 2); // revisit each card this many extra times to see cache effect

if (!EMAIL || !PASSWORD) {
  console.error("Set LOGIN_EMAIL and LOGIN_PASSWORD env vars.");
  process.exit(1);
}

const CARD_SELECTOR = ".cursor-pointer[class*='transition-all']";
const TAB_BAR_SELECTOR = "text=Job description";

async function login(page) {
  await page.goto(`${BASE_URL}/auth/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function measureClick(page, card, label) {
  const start = performance.now();
  let networkMs = null;

  const responsePromise = page
    .waitForResponse((res) => res.url().includes("/board-detail") && res.request().method() === "GET", { timeout: 5000 })
    .then(() => {
      networkMs = performance.now() - start;
    })
    .catch(() => {
      /* cache hit — no network call fired, that's fine */
    });

  await card.click();
  await page.waitForSelector(TAB_BAR_SELECTOR, { timeout: 10000 });
  const paintMs = performance.now() - start;
  await responsePromise;

  return { label, networkMs, paintMs: Math.round(paintMs), networkMsRounded: networkMs ? Math.round(networkMs) : null };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await login(page);
  await page.goto(`${BASE_URL}/dashboard`);
  await page.waitForSelector(CARD_SELECTOR, { timeout: 15000 });

  const cards = await page.locator(CARD_SELECTOR).all();
  const targets = cards.slice(0, Math.min(CARD_COUNT, cards.length));
  console.log(`Found ${cards.length} cards, measuring ${targets.length}.`);

  const results = [];

  for (let i = 0; i < targets.length; i++) {
    // Re-query fresh locator each time — the list can re-render between clicks.
    const card = page.locator(CARD_SELECTOR).nth(i);
    const first = await measureClick(page, card, `card[${i}] first-open`);
    results.push(first);

    for (let r = 0; r < REPEAT; r++) {
      // Click a neighbour then click back, to force a real re-select rather than a no-op.
      const other = page.locator(CARD_SELECTOR).nth((i + 1) % targets.length);
      await other.click();
      await page.waitForTimeout(150);
      const revisit = await measureClick(page, card, `card[${i}] revisit-${r}`);
      results.push(revisit);
    }
  }

  await browser.close();

  console.log("\nlabel, network_ms, paint_ms");
  for (const r of results) {
    console.log(`${r.label}, ${r.networkMsRounded ?? "cache-hit"}, ${r.paintMs}`);
  }

  const firstOpens = results.filter((r) => r.label.includes("first-open"));
  const revisits = results.filter((r) => r.label.includes("revisit"));
  const avg = (arr, key) => Math.round(arr.reduce((s, r) => s + r[key], 0) / arr.length);

  console.log("\nSummary:");
  console.log(`  first-open avg paint:  ${avg(firstOpens, "paintMs")}ms`);
  console.log(`  revisit avg paint:     ${avg(revisits, "paintMs")}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
