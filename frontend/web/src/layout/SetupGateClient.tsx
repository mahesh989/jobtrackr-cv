"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side setup gate — checks profile + CV + AI key via a lightweight
 * API endpoint. If setup is incomplete, redirects to the instructions page.
 *
 * Runs in useEffect so it doesn't block page render (LCP). The page header
 * paints immediately; the redirect fires ~200-400ms later if needed.
 *
 * For the ~95% of users with setup complete, the check returns instantly
 * with no visible effect.
 */
export function SetupGateClient() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetch("/api/user/setup-status")
      .then((r) => r.json())
      .then((data: { complete: boolean; step: number }) => {
        if (!data.complete) {
          router.replace(`/dashboard/instructions?tab=setup&setup=1&step=${data.step}`);
        } else {
          setChecked(true);
        }
      })
      .catch(() => setChecked(true)); // fail open — don't block on network error
  }, [router]);

  // Render nothing until the check completes.
  // Users with setup complete see no flash; users needing setup get
  // a brief blank before redirect (~200-400ms).
  return checked ? null : null;
}
