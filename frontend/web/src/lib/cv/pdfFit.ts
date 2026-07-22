/**
 * Adaptive one-page fill for the client-side tailored CV PDF render.
 *
 * The CV_PDF_STYLE sheet is the backend FLOOR layout (10pt / 11pt leading /
 * 0.5in margin). Sparse "tweener" CVs that comfortably fit one page leave a
 * large gap at the bottom because the floor never grows to fill the page.
 *
 * fitCvToPage scales the stylesheet's typographic numerics up (binary search,
 * clamped to 1.15× — matching the backend MAX_CONFIG ceiling of font 11.5pt)
 * so a single-page CV fills ~95% of the usable page before html2canvas
 * captures it. Multi-page CVs (already ≥ one page tall) are left untouched so
 * the existing safe-break slicing keeps working.
 */

// Host-px height of one usable A4 page at CONTENT_W_PX = 698 host-px width.
// usableW = 523.28pt spans 698 host-px → 0.7497 pt/px; usableH = 769.89pt
// → 769.89 / 0.7497 ≈ 1027 host-px.
const ONE_PAGE_HOST_PX = 1027;

const TARGET_FILL = 0.95;   // aim for this fraction of one page
const MAX_FILL    = 0.97;   // never exceed — keeps it single-page-safe
const MAX_SCALE   = 1.45;   // cap zoom at ~1.45× (body 10pt → ~14.5pt) so a
                            // genuinely sparse CV can reach the fill target
                            // without the type looking poster-sized. The binary
                            // search stops at MAX_FILL, so only sparse CVs use
                            // the full headroom.

/** Multiply every pt/px/in numeric in the stylesheet by k. */
function scaleCvStyle(css: string, k: number): string {
  if (k === 1) return css;
  return css.replace(/(-?\d*\.?\d+)(pt|px|in)\b/g, (_m, num: string, unit: string) => {
    const scaled = parseFloat(num) * k;
    return `${Number(scaled.toFixed(4))}${unit}`;
  });
}

const settle = (): Promise<void> =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Grow the CV's typography toward ~95% one-page fill, in place.
 *
 * @param cvRoot   the mounted `.cv-root` element (already laid out)
 * @param styleEl  the `<style>` element holding CV_PDF_STYLE
 * @param baseCss  the original (unscaled) CV_PDF_STYLE string
 *
 * No-op when the content already spans a full page (multi-page path owns it).
 */
export async function fitCvToPage(
  cvRoot: HTMLElement,
  styleEl: HTMLStyleElement,
  baseCss: string,
): Promise<void> {
  await settle();
  const baseH = cvRoot.scrollHeight;

  // Already ≥ one page → leave the multi-page slicing logic untouched.
  if (baseH >= ONE_PAGE_HOST_PX * TARGET_FILL) return;

  const maxH = ONE_PAGE_HOST_PX * MAX_FILL;
  let lo = 1.0;
  let hi = MAX_SCALE;
  let best = 1.0;

  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    styleEl.textContent = scaleCvStyle(baseCss, mid);
    await settle();
    if (cvRoot.scrollHeight <= maxH) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  styleEl.textContent = scaleCvStyle(baseCss, best);
  await settle();
}
