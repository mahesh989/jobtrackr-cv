"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

/**
 * Sort control for the Application pool. Updates the `sort` search param
 * (preserving the active `status` tab), which the server page reads to order
 * the pool. Default is "analyzed" (recently analysed jobs first), so that value
 * is stored implicitly by removing the param.
 */
export type PoolSortKey = "analyzed" | "posted" | "distance";

const OPTIONS: Array<{ value: PoolSortKey; label: string }> = [
  { value: "analyzed", label: "Recently analysed" },
  { value: "posted",   label: "Post date" },
  { value: "distance", label: "Distance (nearest)" },
];

export function ApplicationPoolSort({ current }: { current: PoolSortKey }) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setSort(v: PoolSortKey) {
    const params = new URLSearchParams(sp.toString());
    if (v === "analyzed") params.delete("sort"); else params.set("sort", v);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-text-3">
      Sort by
      <select
        value={current}
        onChange={(e) => setSort(e.target.value as PoolSortKey)}
        disabled={pending}
        className="bg-[var(--surface-2)] border border-[var(--border)] rounded text-[12px] text-text px-2 py-1 cursor-pointer disabled:opacity-60 focus:outline-none focus:border-[var(--brand)]"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
