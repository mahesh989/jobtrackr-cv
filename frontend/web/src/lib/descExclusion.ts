/**
 * Description-exclusion matching for manual JD paste.
 *
 * Mirrors the backend's `buildMatcher` from postFetchFilter.ts:
 *   single word  → word-boundary regex (\bword\b)
 *   multi-word   → literal substring match
 *
 * Used by JobEditModal to warn when a pasted JD contains phrases the user
 * configured as exclusions in their search profile settings.
 */

function buildMatcher(phrase: string): (haystack: string) => boolean {
  const lower = phrase.toLowerCase().trim();
  if (!lower) return () => false;
  const words = lower.split(/\s+/);
  if (words.length === 1) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    return (h) => re.test(h);
  }
  return (h) => h.toLowerCase().includes(lower);
}

export function matchedExclusions(
  text: string,
  excludeKeywords: string,
): string[] {
  if (!text || !excludeKeywords) return [];
  const phrases = excludeKeywords
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return phrases.filter((phrase) => buildMatcher(phrase)(text));
}
