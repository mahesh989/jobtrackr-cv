// Shared aged-care role taxonomy + HTML helpers for the direct-from-employer
// adapters (Workday, Dayforce, PageUp, Scout Talent, Avature).
//
// The whole point of the aged-care sources is a CURATED clinical/care job
// stream, so every adapter filters job TITLES against the same taxonomy instead
// of the caller's free-text profile keywords. Keeping it here means one place to
// tune precision/recall across all aged-care ATSs.

// Role groups chosen with the user (priority nursing):
//   nursing — RN / EN / AIN + spelled-out forms
//   care    — care/support/personal-care workers
//   admin   — administration officers / care coordinators
// Abbreviations use \b word boundaries so "RN" matches "RN — Night Shift" but
// not "lea[rn]ing", and "EN"/"AIN" don't fire inside "tr[ain]ing"/"gov[en]ance".
const ROLE_PATTERNS: { group: string; re: RegExp }[] = [
  { group: "nursing", re: /\bregistered nurse\b|\benrolled nurse\b|\bassistant in nursing\b|\bclinical nurse\b|\bnurse unit manager\b|\b(rn|en|ain)\b/i },
  { group: "care",    re: /\bcare worker\b|\bcarer\b|\bpersonal care\b|\bsupport worker\b|\bhome care\b|\baged care worker\b|\bcare assistant\b|\blifestyle (carer|assistant|officer)\b|\b(pcw|pca)\b/i },
  { group: "admin",   re: /\badministration (officer|assistant|coordinator)\b|\badmin (officer|assistant)\b|\bcare coordinator\b|\brostering\b/i },
];

/** Returns the matched role group, or null when the title is not in scope. */
export function matchRole(title: string): string | null {
  for (const { group, re } of ROLE_PATTERNS) {
    if (re.test(title)) return group;
  }
  return null;
}

/** Strip HTML tags + decode common entities → plain text for the pipeline. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|section|article)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
