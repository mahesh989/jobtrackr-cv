/** Human-readable relative date. Returns null if input is null. */
export function relativeDate(d: string | null): string | null {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return "just now";
  if (hours < 1) return `${mins}m ago`;
  if (days < 1) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** ISO date → "22 Jul 2026". Null-safe ("—" fallback). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/** ISO date → "22 Jul 2026, 14:32". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
