/**
 * WCAG contrast regression test for the theme token system.
 *
 * `globals.css:775–779` used to document Aurora's contrast ratios as a
 * comment — comments don't fail. This test parses the actual token
 * values for every theme straight out of `globals.css` (no hand-copied
 * hex, so it can't drift from the source of truth) and asserts the
 * minimum WCAG 2.1 contrast ratio for the pairs that matter most:
 * body text, secondary text, the brand button label, and the three
 * status-chip foreground/background pairs.
 *
 * Token resolution mirrors the real cascade: each `:root.theme-*` block
 * overrides only the tokens it needs to change, so a token missing from
 * a theme's block falls back to the base `:root` block — exactly how
 * the browser resolves it on `<html class="theme-*">`.
 *
 * Only literal hex values are evaluated. If a token were to resolve to
 * `var(...)` or `color-mix(...)` the corresponding assertion is skipped
 * rather than crashing (see `resolveHex`) — at the time this test was
 * written every pair below is literal hex in every theme, so nothing
 * is expected to actually skip; the skip path exists purely so a future
 * token edit degrades this test gracefully instead of throwing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS_PATH = fileURLToPath(new URL("../app/globals.css", import.meta.url));
const css = readFileSync(CSS_PATH, "utf8");

// ── CSS block extraction ────────────────────────────────────────────────────

/**
 * Finds every top-level rule whose selector matches `selectorSource`
 * exactly (not as a prefix of a longer selector — e.g. the bare `:root`
 * pattern must not match `:root.theme-classic`) and returns each rule's
 * declaration body. Brace-depth counting (rather than a `[^}]*` regex)
 * so a stray `{`/`}` inside a value can't truncate the match early.
 */
function extractBlocks(selectorSource: string): string[] {
  // The selector must start at the beginning of the file or right after
  // one of `;`, `}`, or a newline — this is what stops ":root" from
  // matching in the middle of ":root.theme-classic".
  const re = new RegExp(`(?:^|[;}\\n])\\s*(${selectorSource})\\s*\\{`, "g");
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const openBrace = m.index + m[0].length - 1;
    let depth = 1;
    let i = openBrace + 1;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(openBrace + 1, i - 1));
    re.lastIndex = i;
  }
  return blocks;
}

/** Parses `--token: value;` declarations out of a block body. Later
 * declarations of the same token (within the block, or across blocks
 * when merged by the caller) win, matching source-order cascade. */
function parseTokens(body: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /--([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    tokens[`--${m[1]}`] = m[2].trim();
  }
  return tokens;
}

function mergedTokens(selectorSource: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const block of extractBlocks(selectorSource)) {
    Object.assign(merged, parseTokens(block));
  }
  return merged;
}

// Base falls back for every theme — merges every un-classed `:root { }`
// block in the file (there are several: the Default theme's own tokens,
// the density-scale block, the shared card/chart-token block, and the
// semantic-vocabulary block added in Phase 0).
const BASE_TOKENS = mergedTokens(":root");

const THEMES: { name: string; selector: string }[] = [
  { name: "Default", selector: ":root" },
  { name: "classic", selector: ":root\\.theme-classic" },
  { name: "gilded-noir", selector: ":root\\.theme-gilded-noir" },
  { name: "notion", selector: ":root\\.theme-notion" },
  { name: "clay", selector: ":root\\.theme-clay" },
  { name: "aurora-dark", selector: ":root\\.theme-aurora-dark" },
  { name: "aurora-light", selector: ":root\\.theme-aurora-light" },
];

// ── Token resolution (with cascade fallback to base) ────────────────────────

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(hex: string): string {
  const body = hex.slice(1);
  const six = body.length === 3
    ? body.split("").map((c) => c + c).join("")
    : body;
  return `#${six.toUpperCase()}`;
}

/** Resolves a token to a literal hex string for the given theme, falling
 * back to the base `:root` block. Returns null (skip, don't crash) if the
 * token is missing entirely or resolves to something that isn't a plain
 * hex literal (a `var()` reference, `color-mix()`, etc.). */
function resolveHex(themeTokens: Record<string, string>, token: string): string | null {
  const raw = themeTokens[token] ?? BASE_TOKENS[token];
  if (raw === undefined) return null;
  if (!HEX_RE.test(raw)) return null;
  return normalizeHex(raw);
}

// ── WCAG 2.1 contrast ────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance per WCAG 2.1 §1.4.3 (sRGB). */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [channel(r), channel(g), channel(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** WCAG 2.1 §1.4.3 contrast ratio, always ≥ 1. */
function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexToRgb(hexA)) + 0.05;
  const lB = relativeLuminance(hexToRgb(hexB)) + 0.05;
  return lA > lB ? lA / lB : lB / lA;
}

// ── Assertions ───────────────────────────────────────────────────────────────

type Pair = { label: string; fg: string; bg: string; min: number };

const PAIRS: Pair[] = [
  { label: "--text on --surface", fg: "--text", bg: "--surface", min: 4.5 },
  { label: "--text-2 on --surface", fg: "--text-2", bg: "--surface", min: 4.5 },
  { label: "--text-3 on --surface", fg: "--text-3", bg: "--surface", min: 3.0 },
  { label: "--brand-fg on --brand", fg: "--brand-fg", bg: "--brand", min: 4.5 },
  { label: "--green on --green-light", fg: "--green", bg: "--green-light", min: 4.5 },
  { label: "--amber on --amber-light", fg: "--amber", bg: "--amber-light", min: 4.5 },
  { label: "--red on --red-light", fg: "--red", bg: "--red-light", min: 4.5 },
];

describe("theme contrast (WCAG 2.1)", () => {
  for (const theme of THEMES) {
    const tokens = theme.name === "Default" ? BASE_TOKENS : mergedTokens(theme.selector);

    describe(theme.name, () => {
      for (const pair of PAIRS) {
        const fgHex = resolveHex(tokens, pair.fg);
        const bgHex = resolveHex(tokens, pair.bg);
        const testName = `${pair.label} >= ${pair.min}`;

        if (fgHex === null || bgHex === null) {
          it.skip(`${testName} (skipped: token did not resolve to a literal hex value)`, () => {});
          continue;
        }

        it(testName, () => {
          const ratio = contrastRatio(fgHex, bgHex);
          expect(
            ratio,
            `${theme.name}: ${pair.label} = ${ratio.toFixed(2)} (need ${pair.min.toFixed(1)})`,
          ).toBeGreaterThanOrEqual(pair.min);
        });
      }
    });
  }
});
