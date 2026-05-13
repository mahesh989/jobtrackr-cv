"use client";

import { useTransition } from "react";
import { toggleProfileActive } from "@/lib/actions";

export function ToggleActiveButton({
  profileId,
  isActive,
}: {
  profileId: string;
  isActive: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function handleToggle() {
    startTransition(async () => {
      await toggleProfileActive(profileId, !isActive);
    });
  }

  return (
    <button
      onClick={handleToggle}
      disabled={pending}
      className={`inline-flex items-center gap-2 text-[12px] font-medium transition-colors disabled:opacity-50 ${
        isActive ? "text-[#1A7F37]" : "text-[#9198A1] hover:text-[#1F2328]"
      }`}
    >
      {/* Toggle pill */}
      <span
        className={`relative flex h-4 w-7 shrink-0 rounded-full transition-colors ${
          isActive ? "bg-[#1A7F37]" : "bg-[#D0D7DE]"
        }`}
      >
        <span
          className={`absolute top-[2px] h-3 w-3 rounded-full bg-white shadow transition-all ${
            isActive ? "left-[14px]" : "left-[2px]"
          }`}
        />
      </span>
      {pending ? "Switching…" : isActive ? "Auto-run on" : "Manual only"}
    </button>
  );
}
