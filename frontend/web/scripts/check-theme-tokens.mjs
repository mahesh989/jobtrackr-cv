#!/usr/bin/env node
/**
 * Theme token guard — structural edition. Hard CI gate (exits 1 on findings).
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
 * It flags five things in every `src/**\/*.tsx` file:
 *   1. raw Tailwind palette utilities (bg-amber-50, text-red-600, …) —
 *      these look right in dev and are correct on exactly one theme.
 *   2. arbitrary hex in class position (bg-[#fafbfc]) — same problem,
 *      worse: no autocomplete either.
 *   2b. literal hex in an inline `style={{ … }}` object. Added after the
 *      Phase 5 migration, because categories 1 and 2 only ever look at
 *      className — so a theme-blind `style={{ color: "#22C55E" }}` sailed
 *      through the entire migration untouched. Two did exactly that.
 *   3. `dark:` variants — this app's "dark" themes are class-based
 *      (`.theme-aurora-dark`, `.theme-gilded-noir`), not OS-preference-
 *      based, so an OS-keyed `dark:` class is simply wrong here.
 *   4. `text-white` / `text-black` co-occurring with a --brand/--success/
 *      --warning/--danger/--info background — either the arbitrary-value
 *      form (`bg-[var(--brand)]`) or the Tailwind alias form (`bg-brand`)
 *      — in the same className. The matching `-fg` token (`--brand-fg`,
 *      `--success-fg`, `--warning-fg`, ...) exists precisely so button/
 *      pill labels stay legible across all seven themes; hardcoding
 *      white/black assumes the background is always one fixed lightness,
 *      which is false on 2-3 of 7 themes per token (see the Phase 0 /
 *      C37-C38 contrast fixes in themeContrast.test.ts).
 *
 *      Known remaining gap, NOT closed by this category (audit finding
 *      #48): a bare `bg-white`/`bg-black` used as a CHILD element's own
 *      background against a PARENT element's brand/status background
 *      (e.g. a toggle-switch knob) is invisible to this scan, which only
 *      looks at co-occurrence within one className string. Closing that
 *      needs real JSX-structural (parent/child) analysis, not a regex
 *      scan over class strings — a naive "flag every bg-white anywhere"
 *      rule would false-positive on every legitimate white surface.
 *      Left for a dedicated follow-up rather than guessed at here.
 *
 * *** ENFORCING as of 2026-08-07 (Phase 6) — this fails the build. ***
 * It ran report-only through Phase 5 while the 630-finding backlog was
 * migrated, then flipped to `exit(1)` once the tree was clean, and is
 * wired into the `guards` job in .github/workflows/ci.yml. Same shape as
 * check-route-auth.mjs: a finding either gets fixed or gets an ALLOWLIST
 * entry with a written justification — silence is not an option.
 *
 * BUG-12 (resolved 2026-08-07): the Aurora `!important` remap block in
 * globals.css used to be load-bearing for CalloutStrip.tsx/StatCards.tsx
 * (since renamed to NextActions.tsx/ProgressLine.tsx) and PipelineDonut.tsx,
 * which were temporarily allowlisted here while a parallel branch rewrote
 * them. All three are now migrated onto the semantic token vocabulary, the
 * allowlist entries are gone, and the remap block itself has been deleted
 * from globals.css — this guard is what replaces it.
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
  "lib/cv/pdfRender.tsx":
    "off-screen PDF renderer (html2canvas + jsPDF) — white paper, black body, navy links are fixed print colours; the output must be byte-faithful to TailoredCvCard's preview regardless of the user's app theme",
  "features/profiles/components/LiveLogConsole.tsx":
    "terminal emulator — the GitHub-dark console palette is the point, not a theme surface",
  "features/auth/components/brand.tsx":
    "Google's brand SVG — the four-colour mark is trademark-fixed and must not be recoloured",
  "lib/ai/models.ts":
    "PROVIDER_META.color is each AI provider's own real-world brand colour (Anthropic/OpenAI/DeepSeek), not an app UI theme surface — same trademark-fixed rationale as brand.tsx. Also a false positive of INLINE_STYLE_HEX_RE specifically: it's a plain data-object field named `color`, not a JSX style prop, and the regex can't tell those apart from source text alone.",
};

// ── Category patterns ────────────────────────────────────────────────────

// Raw Tailwind palette utilities. `\b` before the property name stops this
// matching mid-identifier (e.g. inside a longer, unrelated word); a
// following `:`, quote, space, brace, paren or backtick means "start of a
// class token" for every way these appear in TSX (plain strings, template
// literals, conditional expressions, `dark:`/`hover:` modifier chains).
export const PALETTE_RE =
  /\b(bg|text|border|ring|fill|stroke|from|to|via|shadow|divide|outline|accent|placeholder|decoration)-(red|green|emerald|amber|yellow|blue|sky|teal|purple|violet|indigo|pink|rose|orange|slate|gray|zinc|neutral|stone|lime|cyan|fuchsia)-(50|100|200|300|400|500|600|700|800|900|950)\b/g;

// Arbitrary literal colours in class position. The utility prefix is kept
// generic so a new Tailwind colour-bearing utility cannot bypass the guard.
export const ARBITRARY_HEX_RE =
  /\b[a-z][\w-]*-\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^\]\r\n]*\))\]/g;

// `dark:` variant — this app has no OS-preference-based dark mode.
const DARK_VARIANT_RE = /\bdark:/g;

// Literal hex inside an inline style object — style={{ color: "#22C55E" }}.
// This was a genuine blind spot: the class-based patterns above never see
// inline styles, so two theme-blind colours (the card star toggle and the
// running-profile dot) survived the whole Phase 5 migration untouched.
// Matches a CSS-ish property name followed by a quoted hex, which is what
// an inline style value looks like and what a className never does.
const INLINE_STYLE_HEX_RE =
  /\b(color|background|backgroundColor|borderColor|borderTopColor|borderRightColor|borderBottomColor|borderLeftColor|fill|stroke|outlineColor|boxShadow|caretColor|textDecorationColor)\s*:\s*["'`][^"'`]*#[0-9a-fA-F]{3,8}/g;

// className value extraction: className="...", className='...', or
// className={`...`}. Doesn't attempt to parse clsx()/cn() call arguments
// or className={cond ? "a" : "b"} ternaries — those are rarer and this is
// a regex scan over class strings, not an exhaustive AST-level check.
const CLASSNAME_VALUE_RE = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\})/g;

export function countMatches(re, text) {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

// Brand/status background: either the arbitrary-value form
// (bg-[var(--brand)]) or the Tailwind alias form (bg-brand) — for any of
// the five semantic families that ship a matching -fg contrast token.
// Negative lookahead stops the alias form matching a LONGER class it's a
// prefix of (bg-brand-fg, bg-success-subtle, bg-warning-border, ...) —
// those are either the fix itself or a different, paler background this
// category isn't about.
const BRAND_STATUS_BG_RE =
  /\bbg-\[var\(--(brand|success|warning|danger|info)\)\]|\bbg-(brand|success|warning|danger|info)(?![\w-])/;

function countBrandWhiteOnBlack(text) {
  let count = 0;
  let m;
  CLASSNAME_VALUE_RE.lastIndex = 0;
  while ((m = CLASSNAME_VALUE_RE.exec(text))) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (BRAND_STATUS_BG_RE.test(value) && (/\btext-white\b/.test(value) || /\btext-black\b/.test(value))) {
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
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const CATEGORIES = ["palette", "arbitraryHex", "inlineStyleHex", "darkVariant", "brandWhiteOnBlack"];
const totals = { palette: 0, arbitraryHex: 0, inlineStyleHex: 0, darkVariant: 0, brandWhiteOnBlack: 0 };
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
    inlineStyleHex: countMatches(INLINE_STYLE_HEX_RE, src),
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
    if (counts.inlineStyleHex) parts.push(`inlineStyleHex=${counts.inlineStyleHex}`);
    if (counts.darkVariant) parts.push(`dark:=${counts.darkVariant}`);
    if (counts.brandWhiteOnBlack) parts.push(`brandWhiteOnBlack=${counts.brandWhiteOnBlack}`);
    console.log(`   • ${rel} — ${fileTotal} (${parts.join(", ")})`);
  }
}

console.log("\nTotals by category:");
console.log(`   raw palette utilities:        ${totals.palette}`);
console.log(`   arbitrary hex in class pos.:  ${totals.arbitraryHex}`);
console.log(`   literal hex in inline style:  ${totals.inlineStyleHex}`);
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
