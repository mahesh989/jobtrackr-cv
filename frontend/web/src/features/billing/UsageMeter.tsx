import { Infinity as InfinityIcon } from "lucide-react";

/**
 * A single labelled usage bar. `limit === null` means unlimited (no bar, ∞).
 * Presentational only — safe to render from a server component.
 */
export function UsageMeter({
  label,
  used,
  limit,
  hint,
}: {
  label: string;
  used: number;
  limit: number | null;
  hint?: string;
}) {
  const unlimited = limit === null;
  const pct = unlimited || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const near = !unlimited && pct >= 80;
  const full = !unlimited && used >= (limit ?? 0);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-text">{label}</span>
        <span className={"text-xs font-semibold " + (full ? "text-red-600" : near ? "text-amber-600" : "text-text-2")}>
          {unlimited ? (
            <span className="inline-flex items-center gap-1">
              {used} <InfinityIcon className="h-3.5 w-3.5" />
            </span>
          ) : (
            `${used} / ${limit}`
          )}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={"h-full rounded-full transition-all " + (full ? "bg-red-500" : near ? "bg-amber-500" : "bg-[var(--brand)]")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {hint && <p className="mt-1 text-caption text-text-2">{hint}</p>}
    </div>
  );
}
