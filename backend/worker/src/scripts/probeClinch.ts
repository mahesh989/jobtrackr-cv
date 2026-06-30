/**
 * Clinch diagnostic — why does detail extraction yield 0 JDs?
 *   cd backend/worker && npx tsx src/scripts/probeClinch.ts
 * Reveals: (1) Node-fetch HTTP status of a detail page (AWS WAF?),
 *          (2) the JSON-LD block shape (@type array? @graph wrapper?).
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HOST = "careers.unitingagewell.org";

const sm = await (await fetch(`https://${HOST}/sitemap.xml`, { headers: { "User-Agent": UA } })).text();
const urls = [...new Set(sm.match(new RegExp(`https://${HOST}/jobs/[a-z0-9-]+`, "gi")) ?? [])];
const care = urls.find((u) => /care|nurse|support|carer|personal|assistant/i.test(u)) ?? urls[0];
console.log("sitemap jobs:", urls.length);
console.log("testing detail:", care);

const res = await fetch(care, { headers: { "User-Agent": UA, Accept: "text/html" } });
console.log("Node fetch status:", res.status);
const html = await res.text();
console.log("bytes:", html.length);

const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
console.log("ld+json blocks:", blocks.length);
for (let i = 0; i < blocks.length; i++) {
  try {
    const d = JSON.parse(blocks[i][1]) as Record<string, unknown>;
    const graph = d["@graph"] ? ` @graph[${(d["@graph"] as unknown[]).length}]` : "";
    console.log(`  block ${i}: @type=${JSON.stringify(d["@type"])}${graph} keys=${Object.keys(d).slice(0, 8).join(",")}`);
    if (Array.isArray(d["@graph"])) {
      for (const g of d["@graph"] as Record<string, unknown>[]) console.log(`     graph item @type=${JSON.stringify(g["@type"])}`);
    }
  } catch (e) {
    console.log(`  block ${i}: PARSE FAIL ${String(e).slice(0, 80)} | head: ${blocks[i][1].slice(0, 100).replace(/\s+/g, " ")}`);
  }
}
process.exit(0);
