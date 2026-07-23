"use client";

import { useEffect, useRef } from "react";
import { markApplicationsSeen } from "@/lib/actions/applications";

/**
 * Fires once on mount to stamp the user's applications_seen_at, clearing the
 * sidebar Applications badge. Mirrors MarkSeenOnLoad for the job feed.
 */
export function MarkSeenOnLoad() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    markApplicationsSeen();
  }, []);
  return null;
}
