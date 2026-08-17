import { describe, expect, it } from "vitest";

import {
  ARBITRARY_HEX_RE,
  PALETTE_RE,
  countMatches,
} from "../../scripts/check-theme-tokens.mjs";
import { findUnwrappedHttpMethods } from "../../scripts/check-route-auth.mjs";

describe("theme-token guard coverage", () => {
  const paletteCases = [
    ["bg", "neutral", "800"],
    ["text", "cyan", "500"],
    ["bg", "slate", "950"],
    ["bg", "lime", "400"],
    ["text", "stone", "700"],
    ["shadow", "red", "500"],
    ["divide", "gray", "200"],
    ["placeholder", "gray", "400"],
    ["accent", "blue", "500"],
    ["outline", "red", "500"],
    ["decoration", "sky", "500"],
    ["fill", "fuchsia", "950"],
  ].map((parts) => parts.join("-"));

  it.each(paletteCases)("flags the complete Tailwind palette token %s", (token) => {
    expect(countMatches(PALETTE_RE, token)).toBe(1);
  });

  const arbitraryCases = [
    ["fill", "#ff0000"],
    ["shadow", "#ff0000"],
    ["bg", "rgb(255,0,0)"],
    ["bg", "hsl(0,0%,0%)"],
  ].map(([utility, value]) => `${utility}-[${value}]`);

  it.each(arbitraryCases)("flags arbitrary colour token %s", (token) => {
    expect(countMatches(ARBITRARY_HEX_RE, token)).toBe(1);
  });
});

describe("route-auth guard coverage", () => {
  it("detects an unwrapped const-arrow method beside a wrapped method", () => {
    const source = `
      export const GET = withUser(async () => Response.json({ ok: true }));
      export const DELETE = async () => Response.json({ ok: true });
    `;

    expect(findUnwrappedHttpMethods(source)).toEqual(["DELETE"]);
  });

  it("accepts a file whose exported methods are all wrapped", () => {
    const source = `
      export const GET = withUser(async () => Response.json({ ok: true }));
      export const POST = withAdmin(async () => Response.json({ ok: true }));
    `;

    expect(findUnwrappedHttpMethods(source)).toEqual([]);
  });
});
