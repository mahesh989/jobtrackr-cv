"use client";

import { useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Pages the gate must never pull the user away from — a user reviewing or
// fixing their billing state (choosing a plan, finishing checkout) takes
// priority over the setup wizard, and /instructions is the gate's own
// destination (redirecting it would stomp deep links like ?tab=howitworks).
const EXEMPT_PREFIXES = ["/billing", "/instructions"];

/**
 * Client-side setup gate — checks profile + CV + AI key via a lightweight
 * API endpoint. If setup is incomplete, redirects to the instructions page.
 *
 * Stands down when:
 *  - the URL carries ?setup=1 — the user is ALREADY inside the guided flow,
 *    on a step screen the wizard itself navigated them to. Redirecting there
 *    would bounce them straight back to the card they just left.
 *  - the pathname is exempt (billing, instructions).
 *
 * Runs in useEffect so it doesn't block page render (LCP). The page header
 * paints immediately; the redirect fires ~200-400ms later if needed.
 * For the ~95% of users with setup complete, the check is a no-op.
 */
export function SetupGateClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const exempt =
    EXEMPT_PREFIXES.some((p) => pathname.startsWith(p)) ||
    searchParams.get("setup") === "1";

  useEffect(() => {
    if (exempt) return; // stay put — user is mid-wizard or on an exempt page
    let cancelled = false;
    fetch("/api/user/setup-status")
      .then((r) => r.json())
      .then((data: { complete: boolean; step: number }) => {
        if (!cancelled && !data.complete) {
          router.replace(`/instructions?tab=setup&setup=1&step=${data.step}`);
        }
      })
      .catch(() => {}); // fail open — don't block on network error
    return () => { cancelled = true; };
  }, [router, exempt, pathname]);

  return null;
}
