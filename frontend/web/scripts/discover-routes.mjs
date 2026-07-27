/**
 * Filesystem scan (no browser) that produces a manifest of every page and API
 * route in the app, so the crawler/measure scripts never hand-maintain a list.
 *
 * Output: scripts/.routes-manifest.json
 *   pages: [{ route, dynamic: boolean, dynamicParams: string[] }]
 *   api:   [{ route, dynamic, dynamicParams, methods: string[] }]
 *
 * `dynamic: true` routes need a real ID seeded before they can be visited —
 * they're listed but the crawler skips auto-navigating them.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join, relative } from "path";

const APP_DIR = join(process.cwd(), "src", "app");

function walk(dir, fileName, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, fileName, acc);
    } else if (entry === fileName) {
      acc.push(full);
    }
  }
  return acc;
}

function toRoute(filePath) {
  let rel = relative(APP_DIR, filePath).replace(/\\/g, "/");
  rel = rel.replace(/\/(page|route)\.tsx?$/, "");
  // Strip Next.js route groups like (dashboard) — they don't appear in the URL.
  rel = rel
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/");
  return "/" + rel;
}

function dynamicParams(route) {
  const matches = [...route.matchAll(/\[([^\]]+)]/g)];
  return matches.map((m) => m[1]);
}

function extractMethods(filePath) {
  const src = readFileSync(filePath, "utf8");
  const methods = [];
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src) ||
        new RegExp(`export\\s+const\\s+${m}\\s*=`).test(src)) {
      methods.push(m);
    }
  }
  return methods;
}

const pageFiles = walk(APP_DIR, "page.tsx");
const routeFiles = walk(APP_DIR, "route.ts");

const pages = pageFiles.map((f) => {
  const route = toRoute(f);
  const params = dynamicParams(route);
  return { route, dynamic: params.length > 0, dynamicParams: params };
});

const api = routeFiles.map((f) => {
  const route = toRoute(f);
  const params = dynamicParams(route);
  return { route, dynamic: params.length > 0, dynamicParams: params, methods: extractMethods(f) };
});

const manifest = { generatedAt: "static-scan", pages, api };
writeFileSync(join(process.cwd(), "scripts", ".routes-manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`Pages: ${pages.length} (${pages.filter((p) => p.dynamic).length} dynamic)`);
console.log(`API routes: ${api.length} (${api.filter((r) => r.dynamic).length} dynamic)`);
console.log(`GET-only, static API routes (safe to auto-hit): ${api.filter((r) => !r.dynamic && r.methods.length === 1 && r.methods[0] === "GET").length}`);
console.log(`Written to scripts/.routes-manifest.json`);
