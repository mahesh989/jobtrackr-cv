#!/usr/bin/env node
/**
 * Theme token guard — structural edition, REPORT-ONLY (Phase 0).
 *
 * docs/UI_IMPROVEMENT_2026-08-06.md §2 diagnoses why the theme system has
 * 559+ hardcoded-colour violations: there was a correct vocabulary
 * (--green/--amber/--red/… and now the semantic --success/--warning/…
 * aliases added alongside this script) but nothing stopped anyone from
 * routing around it with a raw Tailwind palette class instead. This guard
 * is the enforcement boundary that closes that gap, modelled directly on
 * `scripts/check-route-auth.mjs` — same walk-the-tree-and-regex shape,
 * same allowlist-with-a-written-justification pattern.
 *
 * It flags four things in every `src/**\/*.tsx` file:
 *   1. raw Tailwind palette utilities (bg-amber-50, text-red-600, …) —
 *      these look right in dev and are correct on exactly one theme.
 *   2. arbitrary hex in class position (bg-[#fafbfc]) — same problem,
 *      worse: no autocomplete either.
 *   3. `dark:` variants — this app's "dark" themes are class-based
 *      (`.theme-aurora-dark`, `.theme-gilded-noir`), not OS-preference-
 *      based, so an OS-keyed `dark:` class is simply wrong here.
 *   4. `text-white` / `text-black` co-occurring with `bg-[var(--brand)]`
 *      in the same className — the `--brand-fg` token exists precisely
 *      so button/pill labels stay legible across all seven themes;
 *      hardcoding white assumes --brand is always dark, which is false
 *      on Classic/Clay/Gilded Noir/Notion (see the Phase 0 contrast
 *      fixes in themeContrast.test.ts for two themes where it wasn't).
 *
 * *** REPORT-ONLY — this is a Phase 0/5 progress meter, not a gate. ***
 * It always exits 0. Phase 5 (docs/UI_IMPROVEMENT_2026-08-06.md §4) is
 * the mechanical migration of the 559 existing violations onto the
 * semantic vocabulary; Phase 6 deletes the Aurora `!important` remap
 * block (globals.css ~1199–1330) and is the point where this script
 * flips to `process.exit(1)` and gets wired into CI. Until then, run it
 * (`npm run check:theme`) to watch the count go down, not to fail a build.
 *
 * Not wired into CI yet — deliberately, per the phase plan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

// Surfaces that are legitimately not themed. Each entry MUST carry a
// written reason — same discipline as check-route-auth.mjs's
// PUBLIC_ALLOWLIST. Files here are excluded from every category's count.
const ALLOWLIST = {
  "features/cv/analysis/TailoredCvCard.tsx":
    "CV paper preview — deliberately renders on white stock at all times so the on-screen preview matches the exported PDF byte-for-byte",
  "features/applications/components/CvInlinePreview.tsx":
    "same CV paper preview, inline variant — see TailoredCvCard",
  "features/profiles/components/LiveLogConsole.tsx":
    "terminal emulator — the GitHub-dark console palette is the point, not a theme surface",
  "features/auth/components/brand.tsx":
    "Google's brand SVG — the four-colour mark is trademark-fixed and must not be recoloured",
};

// ── Category patterns ────────────────────────────────────────────────────

// Raw Tailwind palette utilities. `\b` before the property name stops this
// matching mid-identifier (e.g. inside a longer, unrelated word); a
// following `:`, quote, space, brace, paren or backtick means "start of a
// class token" for every way these appear in TSX (plain strings, template
// literals, conditional expressions, `dark:`/`hover:` modifier chains).
const PALETTE_RE =
  /\b(bg|text|border|ring|fill|stroke|from|to|via)-(red|green|emerald|amber|yellow|blue|sky|teal|purple|violet|indigo|pink|rose|orange|slate|gray|zinc)-(50|100|200|300|400|500|600|700|800|900)\b/g;

// Arbitrary hex in class position.
const ARBITRARY_HEX_RE = /\b(bg|text|border|ring)-\[#[0-9a-fA-F]{3,8}\]/g;

// `dark:` variant — this app has no OS-preference-based dark mode.
const DARK_VARIANT_RE = /\bdark:/g;

// className value extraction: className="...", className='...', or
// className={`...`}. Doesn't attempt to parse clsx()/cn() call arguments
// or className={cond ? "a" : "b"} ternaries — those are rarer and this is
// a report-only progress meter, not a exhaustive AST-level check.
const CLASSNAME_VALUE_RE = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\})/g;

function countMatches(re, text) {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function countBrandWhiteOnBlack(text) {
  let count = 0;
  let m;
  CLASSNAME_VALUE_RE.lastIndex = 0;
  while ((m = CLASSNAME_VALUE_RE.exec(text))) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (value.includes("bg-[var(--brand)]") && (/\btext-white\b/.test(value) || /\btext-black\b/.test(value))) {
      count++;
    }
  }
  return count;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const CATEGORIES = ["palette", "arbitraryHex", "darkVariant", "brandWhiteOnBlack"];
const totals = { palette: 0, arbitraryHex: 0, darkVariant: 0, brandWhiteOnBlack: 0 };
const perFile = [];
let allowlistedCount = 0;

const allFiles = walk(SRC_DIR);
for (const file of allFiles) {
  const rel = relative(SRC_DIR, file).split("\\").join("/");
  if (Object.prototype.hasOwnProperty.call(ALLOWLIST, rel)) {
    allowlistedCount++;
    continue;
  }
  const src = readFileSync(file, "utf8");

  const counts = {
    palette: countMatches(PALETTE_RE, src),
    arbitraryHex: countMatches(ARBITRARY_HEX_RE, src),
    darkVariant: countMatches(DARK_VARIANT_RE, src),
    brandWhiteOnBlack: countBrandWhiteOnBlack(src),
  };

  const fileTotal = CATEGORIES.reduce((sum, c) => sum + counts[c], 0);
  if (fileTotal === 0) continue;

  for (const c of CATEGORIES) totals[c] += counts[c];
  perFile.push({ rel, counts, fileTotal });
}

perFile.sort((a, b) => b.fileTotal - a.fileTotal);

const grandTotal = CATEGORIES.reduce((sum, c) => sum + totals[c], 0);

console.log("\n=== check-theme-tokens: REPORT ONLY — always exits 0 ===");
console.log("    (progress meter for docs/UI_IMPROVEMENT_2026-08-06.md Phase 5;");
console.log("     flips to enforcing at the end of Phase 6 — see the header comment)\n");

if (perFile.length === 0) {
  console.log("✓ no raw palette / arbitrary-hex / dark: / brand-white-on-black violations found.");
} else {
  console.log("Per-file breakdown (worst offenders first):\n");
  for (const { rel, counts, fileTotal } of perFile) {
    const parts = [];
    if (counts.palette) parts.push(`palette=${counts.palette}`);
    if (counts.arbitraryHex) parts.push(`arbitraryHex=${counts.arbitraryHex}`);
    if (counts.darkVariant) parts.push(`dark:=${counts.darkVariant}`);
    if (counts.brandWhiteOnBlack) parts.push(`brandWhiteOnBlack=${counts.brandWhiteOnBlack}`);
    console.log(`   • ${rel} — ${fileTotal} (${parts.join(", ")})`);
  }
}

console.log("\nTotals by category:");
console.log(`   raw palette utilities:        ${totals.palette}`);
console.log(`   arbitrary hex in class pos.:  ${totals.arbitraryHex}`);
console.log(`   dark: variants:               ${totals.darkVariant}`);
console.log(`   text-white/black on --brand:  ${totals.brandWhiteOnBlack}`);
console.log(`   ────────────────────────────────────`);
console.log(`   TOTAL:                        ${grandTotal}`);
const cleanCount = allFiles.length - perFile.length - allowlistedCount;
console.log(`\n   files scanned: ${allFiles.length} total — ${cleanCount} clean, ${perFile.length} with findings, ${allowlistedCount} allowlisted\n`);

console.log("This is a progress meter, not a gate — always exits 0 until Phase 6.\n");

process.exit(0);
