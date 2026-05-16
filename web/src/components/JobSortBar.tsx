"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

const SORT_OPTIONS = [
  { value: "posted_at",  label: "Date posted" },
  { value: "created_at", label: "Date added" },
  { value: "company",    label: "Company" },
  { value: "title",      label: "Title" },
] as const;

export function JobSortBar({ total }: { total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const currentSort = sp.get("sort") || "posted_at";
  const currentDir  = sp.get("dir")  || "desc";

  function setSort(sort: string) {
    const params = new URLSearchParams(sp.toString());
    if (sort === currentSort) {
      params.set("dir", currentDir === "desc" ? "asc" : "desc");
    } else {
      params.set("sort", sort);
      params.set("dir", "desc");
    }
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  return (
    <div className="flex items-center gap-3 shrink-0 flex-nowrap">
      <p className="text-xs text-text-2 whitespace-nowrap">
        {total.toLocaleString()} result{total !== 1 ? "s" : ""}
      </p>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-medium text-text-3 mr-0.5">Sort</span>
        {SORT_OPTIONS.map((opt) => {
          const active = currentSort === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all border ${
                active
                  ? "bg-text text-[var(--surface)] border-text"
                  : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text"
              }`}
            >
              {opt.label}
              {active && (
                <span className="opacity-60 text-[10px]">
                  {currentDir === "desc" ? "↓" : "↑"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
