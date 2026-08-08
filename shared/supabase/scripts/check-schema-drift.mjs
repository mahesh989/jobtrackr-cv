#!/usr/bin/env node
/**
 * Schema-drift check — migration files vs the LIVE database.
 *
 * Why this exists
 * ---------------
 * On 2026-08-08 every job upsert had been failing silently: `save.ts` writes
 * sponsorship_status / citizen_pr_only / visa_extracted_text to `jobs`, and it
 * has done since the first commit, but NO migration ever added those columns to
 * that table (067 put them on global_jobs only). The old Supabase project had
 * them applied by hand, so everything worked; the moment a new project was
 * built from the files alone, the gap surfaced — as an empty feed, while the
 * pipeline still logged "run complete".
 *
 * The lesson is that the repo's migrations were never the source of truth, and
 * nothing compared them to reality. This does.
 *
 * Parsing rules (learned the hard way)
 * ------------------------------------
 * The same day, a hand-rolled check reported two tables as "defined in no
 * migration" when they were defined all along, and duplicates were committed on
 * top of them. The cause: 001_full_schema.sql MIXES declaration styles —
 * tables consolidated from the older migrations are `CREATE TABLE applications (`
 * (uppercase, NO `public.` prefix), while newer ones are
 * `create table public.x`. So every pattern here is case-insensitive and treats
 * both the `public.` prefix and `if not exists` as optional. Two checks that
 * share a blind spot agreeing is not confirmation.
 *
 * What it can and cannot see
 * --------------------------
 * The live side is read from PostgREST's OpenAPI document, which exposes
 * tables, views, columns, types, NOT NULL and defaults — enough to have caught
 * the outage above. It CANNOT see indexes, RLS policies, triggers, functions,
 * CHECK constraints or ON DELETE actions; catching drift in those needs
 * `pg_dump -s` and a working DB password. Absence of a report here is therefore
 * not proof of a perfectly matching schema, only of matching COLUMNS.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node check-schema-drift.mjs
 *   node check-schema-drift.mjs --json      # machine-readable
 *
 * Exit 0 = no column drift, 1 = drift found, 2 = could not run (no creds etc).
 * Skips (exit 0) when credentials are absent so CI without secrets is not
 * blocked — it prints a loud SKIPPED notice rather than a silent pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");
const JSON_OUT = process.argv.includes("--json");

// Tables the app deliberately does not own or read through PostgREST.
const IGNORE_TABLES = new Set([
  "schema_migrations",
]);

// ── Parse the migration files ───────────────────────────────────────────────

/** Strip line and block comments so commented-out DDL never counts. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Split a CREATE TABLE body on top-level commas only, so that types carrying
 * their own parens — numeric(8,2), check (x in ('a','b')) — stay intact.
 */
function topLevelParts(body) {
  const parts = [];
  let depth = 0, cur = "", inStr = false;
  for (const ch of body) {
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const CONSTRAINT_WORDS = new Set([
  "unique", "primary", "foreign", "check", "constraint", "exclude", "like", "index",
]);

function columnsFromBody(body) {
  const cols = new Set();
  for (const part of topLevelParts(body)) {
    const m = /^\s*"?([a-z_][a-z0-9_]*)"?\s+\S/i.exec(part);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (CONSTRAINT_WORDS.has(name)) continue;
    cols.add(name);
  }
  return cols;
}

/** Find the matching close paren for the CREATE TABLE argument list. */
function balancedBody(sql, openIdx) {
  let depth = 0, inStr = false;
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inStr = !inStr;
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return sql.slice(openIdx + 1, i); }
  }
  return null;
}

function parseMigrations() {
  const declared = new Map();   // table -> Set(columns)
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`no .sql files in ${MIGRATIONS_DIR}`);

  for (const f of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    // CREATE TABLE [IF NOT EXISTS] [public.]name ( ... )
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
    for (let m; (m = createRe.exec(sql)); ) {
      const table = m[1].toLowerCase();
      const body = balancedBody(sql, createRe.lastIndex - 1);
      if (body === null) continue;
      if (!declared.has(table)) declared.set(table, new Set());
      for (const c of columnsFromBody(body)) declared.get(table).add(c);
    }

    // ALTER TABLE [public.]name ADD COLUMN [IF NOT EXISTS] col ... (repeatable
    // in one statement, comma-separated) — this is how most columns arrived.
    const alterRe = /alter\s+table\s+(?:only\s+)?(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi;
    for (let m; (m = alterRe.exec(sql)); ) {
      const table = m[1].toLowerCase();
      const tail = m[2];
      const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
      for (let a; (a = addRe.exec(tail)); ) {
        if (!declared.has(table)) declared.set(table, new Set());
        declared.get(table).add(a[1].toLowerCase());
      }
      // DROP COLUMN must retract a previous declaration, or a column removed
      // by a later migration looks like it still exists in the files.
      const dropRe = /drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
      for (let dcol; (dcol = dropRe.exec(tail)); ) {
        declared.get(table)?.delete(dcol[1].toLowerCase());
      }
    }
  }
  return declared;
}

// ── Read the live schema ────────────────────────────────────────────────────

async function fetchLive(url, key) {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
  });
  if (!res.ok) throw new Error(`PostgREST returned ${res.status} fetching the OpenAPI document`);
  const doc = await res.json();
  const live = new Map();
  for (const [name, def] of Object.entries(doc.definitions ?? {})) {
    const props = def.properties ?? {};
    if (Object.keys(props).length === 0) continue;
    live.set(name.toLowerCase(), new Set(Object.keys(props).map((c) => c.toLowerCase())));
  }
  if (live.size === 0) throw new Error("OpenAPI document exposed no tables — wrong key or schema?");
  return live;
}

// ── Compare ─────────────────────────────────────────────────────────────────

function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("⚠ schema-drift check SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
    console.log("  This is a SKIP, not a pass: column drift is unverified.");
    process.exit(0);
  }

  return fetchLive(url, key).then((live) => {
    const declared = parseMigrations();
    const findings = { missingInDb: [], missingInFiles: [], tablesOnlyInDb: [], tablesOnlyInFiles: [] };

    for (const [table, liveCols] of live) {
      if (IGNORE_TABLES.has(table)) continue;
      const fileCols = declared.get(table);
      if (!fileCols) { findings.tablesOnlyInDb.push(table); continue; }
      for (const c of liveCols) if (!fileCols.has(c)) findings.missingInFiles.push(`${table}.${c}`);
      for (const c of fileCols) if (!liveCols.has(c)) findings.missingInDb.push(`${table}.${c}`);
    }
    for (const table of declared.keys()) {
      if (IGNORE_TABLES.has(table)) continue;
      // A table absent from PostgREST may simply be unexposed (a view, or not
      // in the exposed schema) rather than missing, so this is reported at a
      // lower confidence than column drift.
      if (!live.has(table)) findings.tablesOnlyInFiles.push(table);
    }

    if (JSON_OUT) { console.log(JSON.stringify(findings, null, 2)); }
    else {
      const line = (label, items, note) => {
        if (items.length === 0) return;
        console.log(`\n${label} (${items.length})${note ? `\n   ${note}` : ""}`);
        for (const i of items.sort()) console.log(`   - ${i}`);
      };
      line("✗ IN THE DATABASE, MISSING FROM THE MIGRATIONS", findings.missingInFiles,
           "A rebuild from these files would NOT produce these. Hand-applied, or lost in a squash.");
      line("✗ IN THE MIGRATIONS, MISSING FROM THE DATABASE", findings.missingInDb,
           "Code reading these gets a 42703/PGRST error. THIS is the shape of the 2026-08-08 outage.");
      line("• tables only in the database", findings.tablesOnlyInDb, "Views are expected here.");
      line("• tables only in the migrations", findings.tablesOnlyInFiles, "Unexposed tables/views are expected here.");
    }

    // Only COLUMN drift fails the build. Table-level differences are noisy by
    // nature (views, unexposed schemas) and would train people to ignore this.
    const hard = findings.missingInDb.length + findings.missingInFiles.length;
    if (hard === 0) {
      console.log("\n✓ schema drift: none. Every live column is declared, and every declared column exists.");
      console.log("  (columns only — indexes, RLS, triggers and constraints need `pg_dump -s`.)");
      process.exit(0);
    }
    console.error(`\n✗ schema drift: ${hard} column difference(s). See above.`);
    process.exit(1);
  }).catch((err) => {
    console.error(`✗ schema-drift check could not run: ${err.message}`);
    process.exit(2);
  });
}

main();
