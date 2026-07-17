"use client";

/**
 * "← Back" button for pages reached from a dashboard stat card.
 *
 * Prefers the explicit origin stored in sessionStorage ("lastDashboardTab")
 * to avoid history ambiguity; falls back to router.back() when absent.
 */

import { useRouter } from "next/navigation";
import { Button } from "@/ui";

export function BackButton() {
  const router = useRouter();

  function handleBack() {
    let target: string | null = null;
    try {
      target = sessionStorage.getItem("lastDashboardTab");
      if (target) sessionStorage.removeItem("lastDashboardTab");
    } catch {
      target = null;
    }
    if (target) router.push(target);
    else router.back();
  }

  return (
    <Button
      onClick={handleBack}
      className="inline-flex items-center gap-1 text-[12px] text-text-2 hover:text-text transition-colors"
    >
      ← Back
    </Button>
  );
}
