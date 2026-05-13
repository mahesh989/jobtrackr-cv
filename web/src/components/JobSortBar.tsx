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
    <div className="flex items-center justify-between gap-3">
      <p className="text-[12px] text-[#656D76]">
        {total.toLocaleString()} result{total !== 1 ? "s" : ""}
      </p>

      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-[#9198A1] mr-0.5">Sort</span>
        {SORT_OPTIONS.map((opt) => {
          const active = currentSort === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all border ${
                active
                  ? "bg-[#1F2328] text-white border-[#1F2328]"
                  : "bg-white border-[#D0D7DE] text-[#656D76] hover:text-[#1F2328]"
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
