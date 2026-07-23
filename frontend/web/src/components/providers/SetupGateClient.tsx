"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { X, ChevronRight } from "lucide-react";

// Pages the gate must never pull the user away from — a user reviewing or
// fixing their billing state (choosing a plan, finishing checkout) takes
// priority over the setup wizard, and /instructions is the gate's own
// destination (redirecting it would stomp deep links like ?tab=howitworks).
const EXEMPT_PREFIXES = ["/billing", "/instructions"];

// localStorage: setup known complete — skip the check entirely on every
// subsequent page load (cleared never; setup can't meaningfully regress, and
// the gate is an onboarding aid, not an access control).
const COMPLETE_KEY = "jt_setup_complete";
// sessionStorage: the one forced redirect per browser session has been used.
// After it, incomplete setup surfaces as a dismissible banner — the user is
// free to browse (their explicit ask: "let user decide").
const REDIRECTED_KEY = "jt_setup_redirected";
// sessionStorage: the user closed the banner — stay closed for the session.
const DISMISSED_KEY = "jt_setup_banner_dismissed";

/**
 * Client-side setup gate — checks setup progress via a lightweight API
 * endpoint.
 *
 * Behaviour:
 *  - Setup complete (cached in localStorage after first confirmation): no-op.
 *  - Incomplete, FIRST navigation of the session: redirect to /instructions
 *    (the guided wizard), covering the page with an overlay while the check
 *    resolves so the user doesn't see a flash of the wrong page.
 *  - Incomplete, any later navigation: the user stays where they are; a
 *    dismissible banner offers "Continue setup". No more forced redirects.
 *
 * Stands down entirely when the URL carries ?setup=1 (the user is already on
 * a wizard step screen) or the pathname is exempt (billing, instructions).
 */
export function SetupGateClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const exempt =
    EXEMPT_PREFIXES.some((p) => pathname.startsWith(p)) ||
    searchParams.get("setup") === "1";

  const [banner, setBanner] = useState<{ step: number } | null>(null);
  const [covering, setCovering] = useState(false);

  useEffect(() => {
    // This component lives in the persistent dashboard layout — it does NOT
    // unmount on navigation. The cover must therefore be cleared explicitly
    // on every route change that doesn't need it; relying on unmount left the
    // overlay up forever after the entry redirect (full white screen).
    //
    // Cover the page ONLY while the FIRST entry check of the session is
    // resolving — prevents the flash of the wrong page a new user used to
    // see before the redirect fired. Every other outcome (exempt page,
    // already-confirmed-complete, later navigations) must show the page
    // immediately. Computed once so there is a single setState call below
    // instead of one scattered across three early-return branches.
    const alreadyComplete = localStorage.getItem(COMPLETE_KEY) === "1";
    const firstEntry = sessionStorage.getItem(REDIRECTED_KEY) !== "1";
    const shouldCover = !exempt && !alreadyComplete && firstEntry;
    // Intentional sync setState: the cover must go up (or down) on THIS
    // commit, before the user perceives the page behind it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCovering(shouldCover);

    if (exempt || alreadyComplete) return; // banner render is also guarded on `exempt`

    // Failsafe: a hung status request can never brick the app behind the cover.
    const failsafe = window.setTimeout(() => setCovering(false), 5000);

    let cancelled = false;
    fetch("/api/user/setup-status")
      .then((r) => r.json())
      .then((data: { complete: boolean; step: number }) => {
        if (cancelled) return;
        if (data.complete) {
          localStorage.setItem(COMPLETE_KEY, "1");
          setCovering(false);
          return;
        }
        if (firstEntry) {
          // One guided redirect per session, then the user browses freely.
          sessionStorage.setItem(REDIRECTED_KEY, "1");
          router.replace(`/instructions?tab=setup&setup=1&step=${data.step}`);
          // Cover stays up during the transition; the effect re-runs on the
          // exempt /instructions pathname and clears it there.
          return;
        }
        setCovering(false);
        if (sessionStorage.getItem(DISMISSED_KEY) !== "1") {
          setBanner({ step: data.step });
        }
      })
      .catch(() => { if (!cancelled) setCovering(false); }); // fail open
    return () => { cancelled = true; window.clearTimeout(failsafe); };
  }, [router, exempt, pathname]);

  if (covering && !exempt) {
    return (
      <div
        className="fixed inset-0 z-50 bg-[var(--bg)]"
        aria-hidden
        data-testid="setup-gate-cover"
      />
    );
  }

  if (!banner || exempt) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-lg border border-[var(--brand)]/30 bg-surface shadow-lg px-4 py-3 max-w-sm anim-in">
      <p className="text-label text-text-2 leading-snug">
        You haven&apos;t finished setting up — a couple of steps remain.
      </p>
      <Link
        href={`/instructions?tab=setup&step=${banner.step}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--brand)] px-3 py-1.5 text-label font-medium text-white hover:opacity-90 transition-opacity"
        onClick={() => setBanner(null)}
      >
        Continue <ChevronRight className="w-3.5 h-3.5" />
      </Link>
      <button
        type="button"
        aria-label="Dismiss setup reminder"
        onClick={() => {
          sessionStorage.setItem(DISMISSED_KEY, "1");
          setBanner(null);
        }}
        className="shrink-0 rounded p-1 text-text-3 hover:text-text hover:bg-[var(--surface-2)] transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
