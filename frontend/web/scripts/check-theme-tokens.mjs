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
 * *** ENFORCING as of 2026-08-07 (Phase 6) — this fails the build. ***
 * It ran report-only through Phase 5 while the 630-finding backlog was
 * migrated, then flipped to `exit(1)` once the tree was clean, and is
 * wired into the `guards` job in .github/workflows/ci.yml. Same shape as
 * check-route-auth.mjs: a finding either gets fixed or gets an ALLOWLIST
 * entry with a written justification — silence is not an option.
 *
 * STILL OUTSTANDING from Phase 6: the Aurora `!important` remap block in
 * globals.css (~1199–1330) has NOT been deleted yet. It remains
 * load-bearing for the three `features/dashboard/*` files temporarily
 * allowlisted below, which still carry raw palette classes because a
 * parallel branch rewrites them. Once those are migrated, drop their
 * allowlist entries and delete the remap block — it is a runtime patch
 * for a compile-time problem and this guard is what replaces it.
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

  // ── TEMPORARY (2026-08-07) — remove these three once the branch lands ──
  // The `dashboard-action-first` branch renames CalloutStrip.tsx to
  // NextActions.tsx and rewrites StatCards.tsx into ProgressLine.tsx.
  // Migrating them on this branch too would turn a clean merge into a
  // modify/delete conflict, so they are exempted rather than fixed here.
  // They must be migrated on that branch, or in a follow-up once both
  // have merged — at which point these three entries come out and the
  // Aurora !important remap block in globals.css can finally be deleted
  // (it is still load-bearing for exactly these files).
  "features/dashboard/CalloutStrip.tsx":
    "TEMPORARY — renamed to NextActions.tsx on dashboard-action-first; migrate there, not here",
  "features/dashboard/PipelineDonut.tsx":
    "TEMPORARY — rewritten on dashboard-action-first; migrate there, not here",
  "features/dashboard/StatCards.tsx":
    "TEMPORARY — replaced by ProgressLine.tsx on dashboard-action-first; migrate there, not here",
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
// a regex scan over class strings, not an exhaustive AST-level check.
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

console.log("\n=== check-theme-tokens: ENFORCING — a finding fails the build ===");
console.log("    (fix it onto the semantic tokens, or add an ALLOWLIST entry");
console.log("     with a written reason — see docs/UI_IMPROVEMENT_2026-08-06.md)\n");

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

if (perFile.length > 0) {
  console.log(
    "FAIL — every finding above must either move onto the semantic tokens\n" +
    "(bg-{family}-subtle / border-{family}-border / text-{family}, or the bare\n" +
    "token for a solid fill) or be added to ALLOWLIST in this file WITH a\n" +
    "written justification. See docs/UI_IMPROVEMENT_2026-08-06.md.\n",
  );
  process.exit(1);
}

console.log("PASS — no raw palette classes, arbitrary hex, or dark: variants outside the allowlist.\n");
process.exit(0);
