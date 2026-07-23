const REL_RT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeDate(d: string | null): string | null {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return REL_RT.format(-mins, "minute");
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return REL_RT.format(-hours, "hour");
  const days = Math.floor(diff / 86400000);
  if (days < 30) return REL_RT.format(-days, "day");
  const months = Math.floor(days / 30);
  return REL_RT.format(-months, "month");
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
