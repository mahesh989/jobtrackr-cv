/**
 * SEEK API discovery script — tries multiple approaches to find what works.
 * Run locally (residential IP = no blocking).
 *
 * Usage:
 *   npx tsx src/scripts/testSeekDirect.ts [keyword]
 */

const keyword = process.argv[2] ?? "Data Analyst";
const slug    = keyword.toLowerCase().replace(/\s+/g, "-");

const HEADERS = {
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const JSON_HEADERS = {
  ...HEADERS,
  "Accept":         "application/json, text/plain, */*",
  "Referer":        "https://www.seek.com.au/",
  "Origin":         "https://www.seek.com.au",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

// ── Approach 1: Extract __NEXT_DATA__ from the HTML search page ───────────────
// SEEK embeds initial job data in the page as JSON — the same data the React
// app uses to render. Works regardless of API changes.
async function tryNextData(): Promise<boolean> {
  const url = `https://www.seek.com.au/${slug}-jobs`;
  console.log(`\n── Approach 1: __NEXT_DATA__ from HTML ──`);
  console.log(`GET ${url}`);

  const res = await fetch(url, { headers: HEADERS });
  console.log(`HTTP ${res.status}`);

  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);

  if (!match) {
    // Try SEEK's own data embedding format
    const match2 = html.match(/window\.SEEK_REDUX_DATA\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (match2) {
      console.log("Found SEEK_REDUX_DATA:", match2[1].slice(0, 200));
      return true;
    }
    console.log("No __NEXT_DATA__ or SEEK_REDUX_DATA found in HTML.");

    // Show what script tags are in the page
    const scripts = [...html.matchAll(/<script[^>]*id="([^"]+)"/g)].map(m => m[1]);
    console.log("Script IDs found:", scripts);
    return false;
  }

  const data = JSON.parse(match[1]) as Record<string, unknown>;
  console.log("__NEXT_DATA__ keys:", Object.keys(data));

  // Try to find job results inside it
  const str = JSON.stringify(data);
  const jobs = str.match(/"title":"[^"]+"/g)?.slice(0, 3) ?? [];
  console.log("Sample job titles found:", jobs);
  return jobs.length > 0;
}

// ── Approach 2: API v4 with X-Seek-* headers ──────────────────────────────────
async function tryApiV4WithHeaders(): Promise<boolean> {
  const url = new URL("https://www.seek.com.au/api/chalice-search/v4/search");
  url.searchParams.set("keywords",    keyword);
  url.searchParams.set("page",        "1");
  url.searchParams.set("pageSize",    "3");
  url.searchParams.set("daterange",   "7");
  url.searchParams.set("sortmode",    "ListedDate");

  console.log(`\n── Approach 2: API v4 + X-Seek headers ──`);
  console.log(`GET ${url}`);

  const res = await fetch(url.toString(), {
    headers: {
      ...JSON_HEADERS,
      "X-Seek-Site":          "AU-Main",
      "X-Seek-Source-System": "houston",
    },
  });

  console.log(`HTTP ${res.status}`);
  const text = await res.text();
  console.log(`Body preview: ${text.slice(0, 200)}`);
  return res.status === 200 && text.startsWith("{");
}

// ── Approach 3: API v5 ────────────────────────────────────────────────────────
async function tryApiV5(): Promise<boolean> {
  const url = new URL("https://www.seek.com.au/api/chalice-search/v5/search");
  url.searchParams.set("siteKey",      "AU-Main");
  url.searchParams.set("sourcesystem", "houston");
  url.searchParams.set("keywords",     keyword);
  url.searchParams.set("page",         "1");
  url.searchParams.set("pageSize",     "3");
  url.searchParams.set("daterange",    "7");
  url.searchParams.set("sortmode",     "ListedDate");

  console.log(`\n── Approach 3: API v5 ──`);
  console.log(`GET ${url}`);

  const res = await fetch(url.toString(), { headers: JSON_HEADERS });
  console.log(`HTTP ${res.status}`);
  const text = await res.text();
  console.log(`Body preview: ${text.slice(0, 200)}`);
  return res.status === 200 && text.startsWith("{");
}

// ── Approach 4: Solr-style search API ─────────────────────────────────────────
async function trySearchApi(): Promise<boolean> {
  const url = `https://www.seek.com.au/api/search?keywords=${encodeURIComponent(keyword)}&daterange=7&sortmode=ListedDate&pageSize=3`;

  console.log(`\n── Approach 4: /api/search ──`);
  console.log(`GET ${url}`);

  const res = await fetch(url, { headers: JSON_HEADERS });
  console.log(`HTTP ${res.status}`);
  const text = await res.text();
  console.log(`Body preview: ${text.slice(0, 200)}`);
  return res.status === 200 && text.startsWith("{");
}

// ── Run all approaches ────────────────────────────────────────────────────────
console.log(`\nSEEK API discovery — keyword: "${keyword}"\n`);

await tryNextData();
await tryApiV4WithHeaders();
await tryApiV5();
await trySearchApi();

console.log("\n── Done ──");
process.exit(0);
