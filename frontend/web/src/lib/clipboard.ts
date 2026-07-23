/**
 * Copy text to the clipboard. Tries the async Clipboard API first, then falls
 * back to the hidden-textarea + execCommand trick (older Safari, non-secure
 * contexts). Returns false when both paths fail so callers can show a manual
 * copy fallback.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}
