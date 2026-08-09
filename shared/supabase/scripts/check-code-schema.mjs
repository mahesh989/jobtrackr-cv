#!/usr/bin/env node
/**
 * Code-vs-schema check — do the columns the CODE touches actually exist?
 *
 * Why this exists, and why check-schema-drift.mjs is not enough
 * ------------------------------------------------------------
 * The 2026-08-08 outage was `save.ts` writing sponsorship_status,
 * citizen_pr_only and visa_extracted_text into `jobs` when that table had none
 * of them. Every upsert failed, no job was ever saved, and the pipeline still
 * logged "run complete" — a total failure that read as a working scrape.
 *
 * A migrations-vs-database diff would NOT have caught it at that moment,
 * because the files and the database agreed: neither had the columns. The
 * disagreement was between the CODE and both. That is the gap this closes.
 *
 * (The sibling check still matters: in the OLD Supabase project those columns
 * DID exist, hand-applied and absent from the files. Run against that project
 * it would have reported them as in-database-but-not-in-migrations, and the
 * loss would never have survived the move to a new project. The two checks
 * cover different halves of the same failure.)
 *
 * Scope — deliberately narrow, to stay trustworthy
 * ------------------------------------------------
 * Only unambiguous, statically-readable usages are checked:
 *   .from("t").select("a, b, c")      → every listed column
 *   .from("t").upsert|insert|update({ a: …, b: … })  → every literal key
 * Anything dynamic (template strings, spreads, variables, computed keys) is
 * SKIPPED rather than guessed at. A checker that cries wolf gets switched off,
 * and this one is meant to survive. Embedded PostgREST syntax — `rel(col)`,
 * `alias:col`, `col->>json`, `count`, `*` — is unwrapped or ignored.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node check-code-schema.mjs
 *   node check-code-schema.mjs --self-test   # prove it catches the real bug
 *
 * Exit 0 = clean (or skipped), 1 = a column the code touches does not exist.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const SCAN_DIRS = ["backend/worker/src", "frontend/web/src"];
const EXTS = new Set([".ts", ".tsx"]);
const SELF_TEST = process.argv.includes("--self-test");

// PostgREST/Supabase pseudo-columns and helpers that are never real columns.
const PSEUDO = new Set(["count", "sum", "avg", "min", "max"]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === "dist") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p)) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Peel PostgREST decoration off one select item; null = not a plain column. */
function normaliseSelectItem(raw) {
  let s = raw.trim();
  if (!s || s === "*") return null;
  if (s.includes("(")) return null;              // embedded resource: rel(cols)
  if (s.includes("!")) return null;              // hint syntax
  if (s.includes(":")) s = s.split(":").pop().trim();   // alias:column
  s = s.split("->")[0].trim();                   // jsonb path
  s = s.replace(/::[a-z_]+$/i, "").trim();       // cast
  s = s.replace(/\.(asc|desc|nullsfirst|nullslast)$/i, "");
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) return null;
  if (PSEUDO.has(s.toLowerCase())) return null;
  return s.toLowerCase();
}

/** Balanced-scan forward from an opening delimiter. */
function balanced(src, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

/**
 * Collect { table, column, file, kind } usages. `.from("t")` is matched first,
 * then the *immediately following* .select/.upsert/.insert/.update within a
 * short window, so a later unrelated .select() is not attributed to this table.
 */
export function collectUsages(src, file = "") {
  const found = [];
  const fromRe = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/gi;
  for (let m; (m = fromRe.exec(src)); ) {
    const table = m[1].toLowerCase();
    // The window MUST stop at the next .from(), or a later query's .select()
    // gets blamed on this table. Skipping that produced 72 confident findings
    // that were almost entirely search_profiles columns attributed to `jobs` —
    // a checker that cries wolf gets switched off, so the window is bounded by
    // the next builder chain, not by a character count alone.
    const after = m.index + m[0].length;
    const nextFrom = src.slice(after).search(/\.from\(\s*["'`]/);
    const end = nextFrom === -1 ? Math.min(src.length, after + 2000)
                                : Math.min(after + nextFrom, after + 2000);
    const window = src.slice(m.index, end);

    const sel = /\.select\(\s*(["'])([\s\S]*?)\1/.exec(window);
    if (sel && !sel[2].includes("${")) {
      for (const item of sel[2].split(",")) {
        const col = normaliseSelectItem(item);
        if (col) found.push({ table, column: col, file, kind: "select" });
      }
    }

    const wRe = /\.(upsert|insert|update)\(\s*\{/.exec(window);
    if (wRe) {
      const braceIdx = m.index + wRe.index + wRe[0].length - 1;
      const body = balanced(src, braceIdx, "{", "}");
      if (body && !body.includes("...")) {          // spreads → unknowable
        let depth = 0, inStr = null;
        for (let i = 0; i < body.length; i++) {
          const ch = body[i];
          if (inStr) { if (ch === inStr && body[i - 1] !== "\\") inStr = null; continue; }
          if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
          if ("{[(".includes(ch)) depth++;
          else if ("}])".includes(ch)) depth--;
          else if (ch === ":" && depth === 0) {
            const before = body.slice(0, i);
            const km = /(?:^|[,{])\s*"?([a-z_][a-z0-9_]*)"?\s*$/i.exec(before);
            if (km) found.push({ table, column: km[1].toLowerCase(), file, kind: "write" });
          }
        }
      }
    }
  }
  return found;
}

async function liveSchema(url, key) {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
  });
  if (!res.ok) throw new Error(`PostgREST returned ${res.status}`);
  const doc = await res.json();
  const m = new Map();
  for (const [name, def] of Object.entries(doc.definitions ?? {})) {
    const props = Object.keys(def.properties ?? {});
    if (props.length) m.set(name.toLowerCase(), new Set(props.map((c) => c.toLowerCase())));
  }
  return m;
}

// ── Self-test: prove it catches the real historical bug ─────────────────────
if (SELF_TEST) {
  const SAVE_TS_EXCERPT = `
    const { error } = await db.from("jobs").upsert({
      profile_id: profileId,
      url_hash: job.url_hash,
      sponsorship_status: job.sponsorship_status,
      citizen_pr_only: job.citizen_pr_only,
      visa_extracted_text: job.visa_extracted_text,
    });`;
  const usages = collectUsages(SAVE_TS_EXCERPT, "save.ts");
  const schemaBefore = new Map([["jobs", new Set(["profile_id", "url_hash"])]]);
  const missing = usages.filter((u) => !schemaBefore.get(u.table)?.has(u.column)).map((u) => u.column);
  const expected = ["sponsorship_status", "citizen_pr_only", "visa_extracted_text"];
  const ok = expected.every((c) => missing.includes(c)) && !missing.includes("profile_id");
  console.log(ok
    ? `✓ self-test: detected ${expected.join(", ")} — the 2026-08-08 outage would have been caught`
    : `✗ self-test FAILED — detected: ${missing.join(", ") || "nothing"}`);
  process.exit(ok ? 0 : 1);
}

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log("⚠ code-vs-schema check SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
  console.log("  This is a SKIP, not a pass.");
  process.exit(0);
}

const schema = await liveSchema(url, key).catch((e) => {
  console.error(`✗ could not read live schema: ${e.message}`); process.exit(2);
});

const problems = [];
let checked = 0;
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    if (/\.test\.tsx?$/.test(file)) continue;
    for (const u of collectUsages(readFileSync(file, "utf8"), file.replace(ROOT + "/", ""))) {
      const cols = schema.get(u.table);
      if (!cols) continue;                    // unknown/unexposed table — not our call
      checked++;
      if (!cols.has(u.column)) problems.push(u);
    }
  }
}

if (problems.length === 0) {
  console.log(`✓ code-vs-schema: ${checked} column usages checked, all exist.`);
  process.exit(0);
}
console.error(`\n✗ code touches ${problems.length} column(s) that do NOT exist:\n`);
const seen = new Set();
for (const p of problems) {
  const k = `${p.table}.${p.column}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.error(`   ${k}   (${p.kind})  ${p.file}`);
}
console.error("\nA write to a missing column fails the WHOLE batch — silently, if the caller only logs.");
process.exit(1);
