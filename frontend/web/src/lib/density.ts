/**
 * Density (a.k.a. "text size") control for JobTrackr.
 *
 * A second, independent axis from the theme. Scales the rem-based type
 * system via the `--ui-scale` CSS variable (see globals.css). Persisted to
 * localStorage under 'jobtrackr-density'; applied pre-paint by the FOUC guard
 * in app/layout.tsx so there's no flash.
 *
 *   compact      → --ui-scale 0.93   (tighter)
 *   comfortable  → --ui-scale 1      (default — no attribute set)
 *   spacious     → --ui-scale 1.09   (larger)
 */
export type Density = "compact" | "comfortable" | "spacious";

const STORAGE_KEY = "jobtrackr-density";
const VALID = new Set<Density>(["compact", "comfortable", "spacious"]);

export const DENSITIES: ReadonlyArray<{ id: Density; name: string; hint: string }> = [
  { id: "compact",     name: "Compact",     hint: "Tighter — fit more on screen" },
  { id: "comfortable", name: "Comfortable", hint: "Default balance" },
  { id: "spacious",    name: "Spacious",    hint: "Larger, easier to read" },
];

export function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  const s = localStorage.getItem(STORAGE_KEY) as Density | null;
  return s && VALID.has(s) ? s : "comfortable";
}

export function applyDensity(d: Density) {
  if (typeof document === "undefined") return;
  if (!VALID.has(d)) d = "comfortable";
  const html = document.documentElement;
  // 'comfortable' is the default (no attribute) so existing themes are
  // unchanged unless the user opts into a denser/looser scale.
  if (d === "comfortable") html.removeAttribute("data-density");
  else html.setAttribute("data-density", d);
  try {
    localStorage.setItem(STORAGE_KEY, d);
  } catch {
    /* private mode — non-fatal */
  }
}
