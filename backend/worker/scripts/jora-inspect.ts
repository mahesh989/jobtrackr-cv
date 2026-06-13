import { chromium } from "playwright";

const BLOCK_TYPES = new Set(["image","stylesheet","font","media","ping","manifest","other"]);

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled","--no-sandbox","--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-AU", timezoneId: "Australia/Sydney",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.route("**/*", (route) =>
    BLOCK_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue()
  );

  await page.goto("https://au.jora.com/j?q=data+analyst&l=Sydney&p=1", { waitUntil: "networkidle", timeout: 30_000 });
  await new Promise(r => setTimeout(r, 3_000));

  // Dump raw HTML — find pagination without waiting for specific selectors
  const html = await page.content();
  console.log("Page length:", html.length);

  // Find pagination by text search in raw HTML
  const paginationIdx = html.toLowerCase().indexOf("pagination");
  const nextIdx       = html.toLowerCase().indexOf('"next"');
  const ariaNextIdx   = html.toLowerCase().indexOf("next page");

  console.log("'pagination' at:", paginationIdx, paginationIdx > 0 ? html.slice(paginationIdx - 50, paginationIdx + 500) : "NOT FOUND");
  console.log("\n'next' at:", nextIdx,           nextIdx > 0       ? html.slice(nextIdx - 50, nextIdx + 300)            : "NOT FOUND");
  console.log("\n'next page' at:", ariaNextIdx,  ariaNextIdx > 0   ? html.slice(ariaNextIdx - 50, ariaNextIdx + 300)    : "NOT FOUND");

  // Also count articles
  const articleCount = (html.match(/<article/gi) || []).length;
  console.log("\nArticle tags in HTML:", articleCount);

  // Find any <nav> block
  const navStart = html.toLowerCase().indexOf("<nav");
  if (navStart > 0) {
    const navEnd = html.indexOf("</nav>", navStart);
    console.log("\nNAV HTML:", html.slice(navStart, navEnd + 6).slice(0, 2000));
  } else {
    console.log("\nNo <nav> found");
  }

  // Save full HTML for manual inspection
  const fs = await import("fs");
  fs.writeFileSync("jora_page_dump.html", html);
  console.log("\nFull HTML saved → jora_page_dump.html");
  await browser.close();
}

main().catch(console.error);
