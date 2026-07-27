/**
 * Broad interaction-latency crawler. Covers three tiers in one pass:
 *
 *   1. PAGE LOADS   — every static route in scripts/.routes-manifest.json
 *                      (run `node scripts/discover-routes.mjs` first)
 *   2. EVERY ENDPOINT — every network response fired during the whole crawl
 *                      is logged with its own timing, so API coverage falls
 *                      out of normal navigation rather than being hand-listed
 *   3. CLICKS        — every tab / safe button found on each visited page
 *
 * Safety: this clicks blind. A DANGER_KEYWORDS blocklist skips anything that
 * looks like it sends email, charges a card, deletes/disconnects/exports
 * data, or submits a form, and only clicks a candidate at all if it matched
 * an explicit "content-loading" allowlist shape (tab, card, expand/collapse,
 * internal nav button) — see isSafeToClick(). Run this ONLY against local
 * dev with a seeded test account. Never point it at production.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   LOGIN_EMAIL=you@example.com LOGIN_PASSWORD=... \
 *   node scripts/measure-everything.mjs
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.LOGIN_EMAIL;
const PASSWORD = process.env.LOGIN_PASSWORD;
const CLICK_TIMEOUT = 4000;
const SETTLE_IDLE_MS = 400;
/** Per-page click cap. Lower = faster run, less coverage. */
const MAX_CLICKS = Number(process.env.MAX_CLICKS ?? 40);
/** How many newly-revealed elements to follow after each click (tabs inside a just-opened panel, etc). */
const MAX_FOLLOW_UPS = Number(process.env.MAX_FOLLOW_UPS ?? 6);
/** Substring filter, comma-separated: PAGES=/dashboard,/cv limits the crawl. */
const PAGE_FILTER = (process.env.PAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * Prefixes to skip entirely: EXCLUDE=/admin when the test account is a plain
 * user. Those routes redirect, and a redirect is worse than useless here — the
 * click loop would run against the landing page while labelling every result
 * with the route we never actually reached.
 */
const EXCLUDE = (process.env.EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * Next dev compiles each route on first visit, so an uncached first load
 * measures webpack, not the app. Warm every page once before measuring.
 * Pointless against a production build — set WARMUP=0 there.
 */
const WARMUP = process.env.WARMUP !== "0";

if (!EMAIL || !PASSWORD) {
  console.error("Set LOGIN_EMAIL and LOGIN_PASSWORD env vars.");
  process.exit(1);
}

/**
 * Label for whatever navigation/click is currently in flight. The request
 * listener stamps it onto every recorded call so the flat network log can be
 * grouped back into "this click caused these requests" during analysis.
 */
let currentContext = "startup";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "scripts", ".routes-manifest.json"), "utf8"));
const staticPages = manifest.pages
  .filter((p) => !p.dynamic)
  .map((p) => p.route)
  .filter((r) => !PAGE_FILTER.length || PAGE_FILTER.some((f) => r.startsWith(f)))
  .filter((r) => !EXCLUDE.some((f) => r.startsWith(f)));

// Never click anything whose visible text matches these, regardless of allowlist shape below.
const DANGER_KEYWORDS = [
  "delete", "remove", "disconnect", "unsubscribe", "cancel", "sign out", "log out", "logout",
  "send", "submit", "confirm", "pay", "upgrade", "downgrade", "purchase", "checkout",
  "export", "revoke", "reset password", "archive",
];

// Only click elements that look like pure content-loading UI.
function isSafeToClick(role, text, className) {
  const t = (text ?? "").toLowerCase();
  if (DANGER_KEYWORDS.some((k) => t.includes(k))) return false;
  if (role === "tab") return true;
  if (/cursor-pointer/.test(className ?? "") && role !== "button") return true; // job/board cards
  if (role === "button" && /^(expand|collapse|show|hide|view|more|less|\d+)/i.test(t)) return true;
  return false;
}

async function login(page) {
  await page.goto(`${BASE_URL}/auth/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function measurePageLoad(page, route) {
  currentContext = `pageload:${route}`;
  const start = Date.now();
  const res = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch((e) => ({ error: e.message }));
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const ms = Date.now() - start;
  // A guard that bounced us elsewhere (admin route as a non-admin, setup gate,
  // expired session) means we measured the landing page, not `route`. Record it
  // as redirected so the caller can skip clicking and the number can't be read
  // as this route's real cost.
  const landed = new URL(page.url()).pathname;
  const redirected = landed !== route;
  return { route, status: res?.status ? res.status() : "error", ms, redirected, landed: redirected ? landed : undefined };
}

async function findClickCandidates(page) {
  return page.evaluate(({ dangerKeywords }) => {
    function isSafe(role, text, className) {
      const t = (text ?? "").toLowerCase();
      if (dangerKeywords.some((k) => t.includes(k))) return false;
      if (role === "tab") return true;
      if (/cursor-pointer/.test(className ?? "") && role !== "button") return true;
      if (role === "button" && /^(expand|collapse|show|hide|view|more|less|\d+)/i.test(t)) return true;
      return false;
    }
    const els = Array.from(document.querySelectorAll("[role='tab'], button, [class*='cursor-pointer']"));
    return els
      .map((el, i) => ({
        i,
        role: el.getAttribute("role") ?? (el.tagName === "BUTTON" ? "button" : null),
        text: el.textContent?.trim().slice(0, 60) ?? "",
        className: el.className?.toString?.() ?? "",
      }))
      .filter((c) => isSafe(c.role, c.text, c.className));
  }, { dangerKeywords: DANGER_KEYWORDS });
}

/**
 * Signature used to collapse REPEATED instances of the same card/row type
 * (61 application rows, 40 job cards, a dozen checkboxes) down to one
 * representative click. Tabs and named buttons are exempt — two tabs sharing
 * a CSS class still load genuinely different content (JD vs Match vs Cover),
 * so those are kept distinct by their label instead. This is what answers
 * "how does each feature load", not "how does clicking work 61 times".
 */
function dedupeKey(c) {
  if (c.role === "tab" || c.role === "button") return `${c.role}:${c.text}`;
  // Card-like repeated rows: same component, different data. Class list
  // (minus nothing dynamic — Tailwind classes here are static) is the type.
  return `card:${c.className}`;
}

async function measureClicks(page, route) {
  const results = [];
  const candidates = await findClickCandidates(page);
  const seenKeys = new Set();

  for (const c of candidates) {
    const key = dedupeKey(c);
    if (seenKeys.has(key)) continue; // one representative click per repeated card TYPE, not per instance
    seenKeys.add(key);
    if (results.length >= MAX_CLICKS) break; // cap per page so one huge list doesn't dominate the run

    const els = page.locator("[role='tab'], button, [class*='cursor-pointer']");
    const el = els.nth(c.i);
    currentContext = `click:${route} -> ${c.text || c.role}`;
    const start = Date.now();
    let clickOk = false;
    try {
      const before = await findClickCandidates(page);
      const beforeKeys = new Set(before.map((b) => dedupeKey(b)));

      await el.click({ timeout: CLICK_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: SETTLE_IDLE_MS + 2000 }).catch(() => {});
      const ms = Date.now() - start;
      results.push({ route, target: c.text || c.role, ms, ok: true });
      clickOk = true;

      // Tabs like Match/CV/Cover Letter/More in BoardDetailPanel don't exist
      // in the DOM until the click that opens their parent panel resolves —
      // a one-shot candidate scan at the top of this function can never see
      // them. Re-scan now and follow anything that's new, one level deep,
      // so those get their own timed click instead of staying invisible.
      const after = await findClickCandidates(page);
      const revealed = after.filter((a) => !beforeKeys.has(dedupeKey(a)));
      let followed = 0;
      for (const r of revealed) {
        if (followed >= MAX_FOLLOW_UPS) break;
        const rEls = page.locator("[role='tab'], button, [class*='cursor-pointer']");
        const rEl = rEls.nth(r.i);
        currentContext = `click:${route} -> ${c.text || c.role} -> ${r.text || r.role}`;
        const rStart = Date.now();
        try {
          await rEl.click({ timeout: CLICK_TIMEOUT });
          await page.waitForLoadState("networkidle", { timeout: SETTLE_IDLE_MS + 2000 }).catch(() => {});
          results.push({ route, target: `${c.text || c.role} -> ${r.text || r.role}`, ms: Date.now() - rStart, ok: true });
        } catch (e) {
          results.push({ route, target: `${c.text || c.role} -> ${r.text || r.role}`, ms: null, ok: false, error: e.message.split("\n")[0] });
        }
        followed++;
      }
    } catch (e) {
      if (!clickOk) results.push({ route, target: c.text || c.role, ms: null, ok: false, error: e.message.split("\n")[0] });
    }
    // Reset to a clean baseline before the next click — but only pay for a full
    // reload when the click actually navigated away. Reloading after every
    // click was the single biggest cost in the run (~25 extra page loads per
    // page); a tab switch or an expander leaves us on the same URL, where
    // closing any modal it opened is a sufficient reset and costs ~1ms.
    const navigatedAway = !page.url().includes(route);
    if (navigatedAway) {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  return results;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Per-request timing. `response` alone only tells us a call happened; the
  // breakdown below is what separates "the server was thinking" (ttfb) from
  // "the payload was huge" (download) — the two have completely different
  // fixes, and guessing between them is how you optimise the wrong thing.
  const responseLog = [];
  page.on("requestfinished", async (req) => {
    const t = req.timing();
    const res = await req.response().catch(() => null);
    let bodyBytes = null;
    try {
      const len = (await res?.headerValue("content-length")) ?? null;
      bodyBytes = len ? Number(len) : null;
    } catch { /* header unavailable on some responses */ }

    responseLog.push({
      url: req.url(),
      method: req.method(),
      status: res?.status() ?? null,
      // Server think time: request sent -> first byte back.
      ttfbMs: t.responseStart > 0 && t.requestStart >= 0 ? Math.round(t.responseStart - t.requestStart) : null,
      // Transfer time: first byte -> last byte.
      downloadMs: t.responseEnd > 0 && t.responseStart > 0 ? Math.round(t.responseEnd - t.responseStart) : null,
      // Connection setup, only non-zero on the first call to an origin.
      connectMs: t.connectEnd > 0 && t.connectStart >= 0 ? Math.round(t.connectEnd - t.connectStart) : null,
      totalMs: t.responseEnd > 0 ? Math.round(t.responseEnd) : null,
      bodyBytes,
      // Server-Timing, if the route emits it. Nothing does today — this is the
      // hook for phase 2, once the slowest routes are known and instrumented.
      serverTiming: (await res?.headerValue("server-timing").catch(() => null)) ?? null,
      // Which page/click was in flight when this fired — turns a flat request
      // log into "this click caused these calls".
      context: currentContext,
      timestamp: Date.now(),
    });
  });

  // Harvested from the board-detail payload while the normal /dashboard click
  // pass runs — `run.id` there IS the analysis_runs id that /jobs/[id]/analyze/
  // [run_id] needs. No separate fetch, no guessed UUID.
  let harvestedJobRun = null;
  page.on("response", async (res) => {
    if (!res.url().includes("/board-detail")) return;
    try {
      const body = await res.json();
      if (body?.run?.id && !harvestedJobRun) {
        const jobId = new URL(res.url()).pathname.split("/")[3];
        harvestedJobRun = { jobId, runId: body.run.id };
      }
    } catch { /* not JSON or already consumed */ }
  });

  page.on("requestfailed", (req) => {
    responseLog.push({
      url: req.url(), method: req.method(), status: null,
      failed: req.failure()?.errorText ?? "failed", context: currentContext, timestamp: Date.now(),
    });
  });

  await login(page);

  if (WARMUP) {
    // Compile every route once, untimed. Without this the first-visit number
    // for each page is dominated by Next's on-demand dev compilation and tells
    // you nothing about the app. Concurrent because we're not measuring here.
    console.log(`Warming ${staticPages.length} routes (dev compile — not measured)...`);
    const warmCtx = await browser.newContext({ storageState: await page.context().storageState() });
    await Promise.all(
      staticPages.map(async (route) => {
        const p = await warmCtx.newPage();
        await p.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await p.close();
      }),
    );
    await warmCtx.close();
    console.log("Warmup done.\n");
  }

  const pageResults = [];
  const clickResults = [];
  const t0 = Date.now();

  for (const [i, route] of staticPages.entries()) {
    console.log(`[${i + 1}/${staticPages.length}] ${route}  (${Math.round((Date.now() - t0) / 1000)}s elapsed)`);
    const result = await measurePageLoad(page, route);
    pageResults.push(result);
    if (result.redirected) {
      console.log(`    ↳ redirected to ${result.landed} — skipping clicks`);
      continue;
    }
    const clicks = await measureClicks(page, route);
    clickResults.push(...clicks);
  }

  // Non-admin dynamic-ID pages. Real IDs come from this account's own data —
  // via the board-detail harvest above (job/run), or a direct call to the
  // BFF's own safe, GET-only, already-authenticated endpoints (same trust
  // boundary the browser itself uses; no separate credential path). Anything
  // this account has none of (e.g. no CVs yet) is skipped and reported, not
  // silently left out.
  console.log("\nSeeding dynamic routes from this account's own data...");
  const fetchJson = (url) => page.evaluate((u) => fetch(u).then((r) => r.ok ? r.json() : null).catch(() => null), url);

  const [cvList, runsList] = await Promise.all([fetchJson(`${BASE_URL}/api/cv`), fetchJson(`${BASE_URL}/api/user/runs`)]);
  const cvId = cvList?.cvs?.[0]?.id ?? null;
  const profileId = runsList?.runs?.[0]?.profile_id ?? null;

  const dynamicTargets = [
    { template: "/cv/[id]/review", route: cvId ? `/cv/${cvId}/review` : null },
    { template: "/profiles/[id]/edit", route: profileId ? `/profiles/${profileId}/edit` : null },
    { template: "/profiles/[id]/jobs", route: profileId ? `/profiles/${profileId}/jobs` : null },
    { template: "/profiles/[id]/runs", route: profileId ? `/profiles/${profileId}/runs` : null },
    {
      template: "/jobs/[id]/analyze/[run_id]",
      route: harvestedJobRun ? `/jobs/${harvestedJobRun.jobId}/analyze/${harvestedJobRun.runId}` : null,
    },
  ];

  for (const t of dynamicTargets) {
    if (!t.route) {
      console.log(`  SKIPPED ${t.template} — no instance found on this account`);
      pageResults.push({ route: t.template, status: "skipped", ms: null, redirected: false });
      continue;
    }
    console.log(`  ${t.template}  ->  ${t.route}`);
    const result = await measurePageLoad(page, t.route);
    result.route = t.template; // report under the template, not the raw UUID
    pageResults.push(result);
    if (!result.redirected) {
      const clicks = await measureClicks(page, t.route);
      clickResults.push(...clicks.map((c) => ({ ...c, route: t.template })));
    }
  }

  await browser.close();

  // Group by route TEMPLATE, not raw path — /api/jobs/abc/board-detail and
  // /api/jobs/def/board-detail are the same endpoint and must aggregate
  // together, or every dynamic route looks like a one-off with n=1.
  function templatise(pathname) {
    return pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/[id]")
      .replace(/\/\d+/g, "/[id]");
  }

  const apiTimings = {};
  for (const r of responseLog) {
    if (!r.url.includes("/api/")) continue;
    const path = templatise(new URL(r.url).pathname);
    const bucket = (apiTimings[path] = apiTimings[path] ?? {
      count: 0, statuses: {}, ttfbs: [], downloads: [], bytes: [], serverTiming: null,
    });
    bucket.count++;
    bucket.statuses[r.status] = (bucket.statuses[r.status] ?? 0) + 1;
    if (r.ttfbMs != null) bucket.ttfbs.push(r.ttfbMs);
    if (r.downloadMs != null) bucket.downloads.push(r.downloadMs);
    if (r.bodyBytes != null) bucket.bytes.push(r.bodyBytes);
    if (r.serverTiming) bucket.serverTiming = r.serverTiming;
  }

  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const max = (a) => (a.length ? Math.max(...a) : null);

  const apiRanked = Object.entries(apiTimings)
    .map(([path, b]) => ({
      path,
      count: b.count,
      medianTtfb: median(b.ttfbs),
      maxTtfb: max(b.ttfbs),
      medianDownload: median(b.downloads),
      medianKb: b.bytes.length ? Math.round(median(b.bytes) / 1024) : null,
      statuses: b.statuses,
      serverTiming: b.serverTiming,
    }))
    .sort((a, b) => (b.medianTtfb ?? 0) - (a.medianTtfb ?? 0));

  const out = { pageResults, clickResults, apiRanked, rawResponses: responseLog };
  writeFileSync(join(process.cwd(), "scripts", ".measure-everything-results.json"), JSON.stringify(out, null, 2));

  console.log("\n=== PAGE LOADS ===");
  pageResults
    .sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1))
    .forEach((r) => console.log(
      r.ms == null
        ? `  --    ${r.route}  [${r.status}]`
        : `${r.ms}ms  ${r.route}  [${r.status}]${r.redirected ? `  ⟶ REDIRECTED to ${r.landed} (ignore this timing)` : ""}`,
    ));

  console.log("\n=== CLICKS (slowest first) ===");
  clickResults
    .filter((r) => r.ok)
    .sort((a, b) => b.ms - a.ms)
    .forEach((r) => console.log(`${r.ms}ms  ${r.route}  -> "${r.target}"`));

  const failed = clickResults.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n=== ${failed.length} CLICK FAILURES (selector/timeout issues, not perf) ===`);
    failed.forEach((r) => console.log(`${r.route} -> "${r.target}": ${r.error}`));
  }

  console.log("\n=== API ENDPOINTS, SLOWEST SERVER TIME FIRST ===");
  console.log("med_ttfb  max_ttfb  med_dl  med_kb  n   path");
  for (const r of apiRanked) {
    const pad = (v, w) => String(v ?? "-").padStart(w);
    console.log(
      `${pad(r.medianTtfb, 8)}  ${pad(r.maxTtfb, 8)}  ${pad(r.medianDownload, 6)}  ${pad(r.medianKb, 6)}  ${pad(r.count, 2)}  ${r.path}` +
      (r.serverTiming ? `\n           server-timing: ${r.serverTiming}` : ""),
    );
  }

  console.log("\n=== SUSPECTS (median TTFB > 300ms) ===");
  const suspects = apiRanked.filter((r) => (r.medianTtfb ?? 0) > 300);
  if (!suspects.length) {
    console.log("None — no endpoint is server-slow. If clicks still feel slow, the cost is client-side render, not the API.");
  } else {
    for (const r of suspects) {
      const bigPayload = (r.medianKb ?? 0) > 200;
      console.log(`${r.path}  (${r.medianTtfb}ms server${bigPayload ? `, ${r.medianKb}KB payload — also check transfer size` : ""})`);
    }
    console.log("\nNext: add Server-Timing to just these routes to split auth vs query cost.");
  }

  console.log(`\nFull results: scripts/.measure-everything-results.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
