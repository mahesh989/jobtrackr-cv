import Link from "next/link";
import type { RangeKey } from "@/lib/admin/guard";

const RANGES: { value: RangeKey; label: string }[] = [
  { value: "7d",  label: "7 days"   },
  { value: "30d", label: "30 days"  },
  { value: "90d", label: "90 days"  },
  { value: "all", label: "All time" },
];

/**
 * Server-renderable range selector. Generates plain <Link> chips.
 * Each chip links to `?range=X` (default "30d" omits the param entirely
 * so bookmarks stay clean and 30d is the canonical URL).
 *
 * Pass `extraParams` to preserve other query params (e.g. "action=invite.generate").
 */
export function RangeFilter({
  current,
  path,
  extraParams = "",
}: {
  current: RangeKey;
  path: string;
  extraParams?: string;
}) {
  function href(range: RangeKey) {
    const parts: string[] = [];
    if (range !== "30d") parts.push(`range=${range}`);
    if (extraParams)      parts.push(extraParams);
    const qs = parts.join("&");
    return `${path}${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {RANGES.map((r) => (
        <Link
          key={r.value}
          href={href(r.value)}
          className={
            "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors " +
            (current === r.value
              ? "bg-text text-bg border-text"
              : "border-border text-text-2 hover:bg-[var(--sidebar-active-bg)]")
          }
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}
