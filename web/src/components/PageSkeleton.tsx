/**
 * Generic page-level loading skeleton shown by loading.tsx files.
 *
 * Renders immediately when Next.js starts a navigation — the user sees
 * activity right away instead of waiting for the server round-trip to
 * complete with no visual feedback.
 */

export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="animate-pulse">
      {/* Simulated header bar */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="h-3 w-32 rounded bg-[var(--surface-2)] mb-2" />
        <div className="h-5 w-56 rounded bg-[var(--surface-2)]" />
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* Simulated funnel / filter row */}
        <div className="flex gap-2">
          {[80, 64, 80, 72, 60, 80].map((w, i) => (
            <div key={i} className="h-14 rounded-md bg-[var(--surface-2)]" style={{ flex: 1 }} />
          ))}
        </div>
        {/* Simulated filter bar */}
        <div className="flex gap-2">
          <div className="h-[30px] w-40 rounded-md bg-[var(--surface-2)]" />
          <div className="h-[30px] w-28 rounded-md bg-[var(--surface-2)]" />
          <div className="h-[30px] w-28 rounded-md bg-[var(--surface-2)]" />
          <div className="flex-1" />
          <div className="h-[30px] w-36 rounded-md bg-[var(--surface-2)]" />
        </div>
        {/* Simulated table rows */}
        <div className="rounded-md border border-border overflow-hidden">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
              <div className="h-3.5 w-4 rounded bg-[var(--surface-2)] shrink-0" />
              <div className="h-3.5 flex-1 rounded bg-[var(--surface-2)]" />
              <div className="h-3.5 w-28 rounded bg-[var(--surface-2)]" />
              <div className="h-3.5 w-20 rounded bg-[var(--surface-2)]" />
              <div className="h-3.5 w-16 rounded bg-[var(--surface-2)]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Minimal single-column content skeleton (instructions, settings pages). */
export function ContentSkeleton() {
  return (
    <div className="animate-pulse px-6 py-8 space-y-6 max-w-3xl">
      <div className="h-7 w-48 rounded bg-[var(--surface-2)]" />
      {[100, 80, 90, 70, 85].map((w, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 rounded bg-[var(--surface-2)]" style={{ width: `${w}%` }} />
          <div className="h-4 rounded bg-[var(--surface-2)]" style={{ width: `${w - 15}%` }} />
        </div>
      ))}
    </div>
  );
}
